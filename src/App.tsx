import { useState, useRef, useEffect, useCallback } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

type IStandaloneCodeEditor = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

const getLanguageFromExtension = (filename: string) => {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "jsx":
      return "javascript";
    case "html":
      return "html";
    case "css":
      return "css";
    case "json":
      return "json";
    default:
      return "plaintext";
  }
};

type FileNode = {
  name: string;
  path: string;
  isFolder: boolean;
  children: { [key: string]: FileNode };
};

const buildTree = (paths: string[]) => {
  const root: FileNode = {
    name: "root",
    path: "",
    isFolder: true,
    children: {},
  };
  paths.forEach((path) => {
    const parts = path.split("/");
    let current = root;
    parts.forEach((part, i) => {
      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isFolder: i < parts.length - 1,
          children: {},
        };
      }
      current = current.children[part];
    });
  });
  return root.children;
};

const FileTreeNode = ({
  node,
  level,
  activeFileName,
  onFileClick,
}: {
  node: FileNode;
  level: number;
  activeFileName: string;
  onFileClick: (path: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const isSelected = !node.isFolder && activeFileName === node.name;

  if (node.isFolder) {
    const sortedChildren = Object.values(node.children).sort((a, b) => {
      if (a.isFolder === b.isFolder) return a.name.localeCompare(b.name);
      return a.isFolder ? -1 : 1;
    });
    return (
      <div>
        <div
          onClick={() => setIsOpen(!isOpen)}
          style={{
            padding: `4px 16px 4px ${16 + level * 12}px`,
            cursor: "pointer",
            color: "#cccccc",
            fontSize: "13px",
            fontFamily: "sans-serif",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#2a2d2e";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <span
            style={{ fontSize: "10px", width: "12px", textAlign: "center" }}
          >
            {isOpen ? "▼" : "▶"}
          </span>
          <span>{node.name}</span>
        </div>
        {isOpen &&
          sortedChildren.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              activeFileName={activeFileName}
              onFileClick={onFileClick}
            />
          ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => onFileClick(node.path)}
      style={{
        padding: `4px 16px 4px ${16 + level * 12 + 18}px`,
        fontSize: "13px",
        fontFamily: "sans-serif",
        color: isSelected ? "#ffffff" : "#cccccc",
        backgroundColor: isSelected ? "#37373d" : "transparent",
        cursor: "pointer",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = "#2a2d2e";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {node.name}
    </div>
  );
};

export default function App() {
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const isApplyingRemoteChange = useRef<boolean>(false);
  const nameTagWidget = useRef<HTMLDivElement | null>(null);
  const fileNameRef = useRef<string>("Waiting for VS Code...");
  const lastHostCursorRef = useRef<{
    line: number;
    column: number;
    userName?: string;
  } | null>(null);
  const webUserNameRef = useRef<string>("Web User");
  const codeUpdateTimeoutRef = useRef<number | null>(null);
  const cursorThrottleRef = useRef<number>(0);

  // Terminal refs
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputBufferRef = useRef<string>("");
  const terminalResizeObserver = useRef<ResizeObserver | null>(null);

  const [status, setStatus] = useState<
    "Connecting" | "Ready" | "Waiting for URL"
  >("Connecting");
  const [code, setCode] = useState<string>("");
  const [fileName, setFileName] = useState<string>("Waiting for VS Code...");
  const [language, setLanguage] = useState<string>("plaintext");
  const [rawFileTree, setRawFileTree] = useState<string[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(false);
  const [isProcessRunning, setIsProcessRunning] = useState<boolean>(false);

  // Ask for username on load
  useEffect(() => {
    let savedName = localStorage.getItem("tameer-username");
    if (!savedName) {
      savedName =
        prompt("Enter your name for Tameer Live Sync:", "Guest Developer") ||
        "Guest Developer";
      localStorage.setItem("tameer-username", savedName);
    }
    webUserNameRef.current = savedName;
  }, []);

  // Initialize xterm.js when terminal panel opens
  useEffect(() => {
    if (!isTerminalOpen || !terminalRef.current) return;
    if (xtermRef.current) return; // already initialized

    const term = new Terminal({
      theme: {
        background: "#1a1a1a",
        foreground: "#d4d4d4",
        cursor: "#d97706",
        selectionBackground: "#d9770640",
        black: "#1e1e1e",
        brightBlack: "#555",
        red: "#f44747",
        brightRed: "#f44747",
        green: "#6a9955",
        brightGreen: "#6a9955",
        yellow: "#d97706",
        brightYellow: "#d97706",
        blue: "#569cd6",
        brightBlue: "#569cd6",
        magenta: "#c586c0",
        brightMagenta: "#c586c0",
        cyan: "#9cdcfe",
        brightCyan: "#9cdcfe",
        white: "#d4d4d4",
        brightWhite: "#ffffff",
      },
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln("\x1b[33m┌─────────────────────────────────┐\x1b[0m");
    term.writeln("\x1b[33m│   Tameer Terminal  ⚡             │\x1b[0m");
    term.writeln("\x1b[33m└─────────────────────────────────┘\x1b[0m");
    term.writeln(
      "\x1b[90mType a command and press Enter to run it on VS Code.\x1b[0m",
    );
    term.writeln("");
    term.write("\x1b[33m$ \x1b[0m");

    term.onKey(({ key, domEvent }) => {
      const channel = channelRef.current;

      if (domEvent.key === "Enter") {
        const cmd = inputBufferRef.current.trim();
        term.write("\r\n");
        if (cmd && channel) {
          if (isProcessRunning) {
            channel.send({
              type: "broadcast",
              event: "terminal-input",
              payload: { input: cmd + "\n" },
            });
          } else {
            setIsProcessRunning(true);
            channel.send({
              type: "broadcast",
              event: "run-command",
              payload: { command: cmd },
            });
          }
        }
        inputBufferRef.current = "";
        return;
      }

      if (domEvent.ctrlKey && domEvent.key === "c") {
        if (channel) {
          channel.send({
            type: "broadcast",
            event: "kill-process",
            payload: {},
          });
          setIsProcessRunning(false);
        }
        term.write("^C\r\n\x1b[33m$ \x1b[0m");
        inputBufferRef.current = "";
        return;
      }

      if (domEvent.key === "Backspace") {
        if (inputBufferRef.current.length > 0) {
          inputBufferRef.current = inputBufferRef.current.slice(0, -1);
          term.write("\b \b");
        }
        return;
      }

      if (key && !domEvent.ctrlKey && !domEvent.altKey && !domEvent.metaKey) {
        inputBufferRef.current += key;
        term.write(key);
      }
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(terminalRef.current);
    terminalResizeObserver.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [isTerminalOpen, isProcessRunning]);

  // Cleanup xterm on unmount
  useEffect(() => {
    return () => {
      xtermRef.current?.dispose();
      terminalResizeObserver.current?.disconnect();
    };
  }, []);

  const renderHostCursor = useCallback(
    (line: number, column: number, userName?: string) => {
      if (!editorRef.current || !monacoRef.current) return;
      const editor = editorRef.current;
      const displayName = userName ? `${userName} (Host)` : "VS Code Host";

      if (nameTagWidget.current) {
        nameTagWidget.current.remove();
        nameTagWidget.current = null;
      }

      const editorDom = editor.getDomNode();
      if (!editorDom) return;

      editor.deltaDecorations(
        [],
        [
          {
            range: new monacoRef.current.Range(line, column, line, column),
            options: { className: "remote-cursor" },
          },
        ],
      );

      const tag = document.createElement("div");
      tag.className = "remote-name-tag";
      tag.innerText = displayName;
      Object.assign(tag.style, {
        position: "absolute",
        background: "#d97706",
        color: "white",
        padding: "2px 6px",
        fontSize: "10px",
        borderRadius: "4px",
        pointerEvents: "none",
        zIndex: "100",
        whiteSpace: "nowrap",
      });

      editorDom.style.position = "relative";
      editorDom.appendChild(tag);
      nameTagWidget.current = tag;

      try {
        const layoutInfo = editor.getLayoutInfo();
        const scrollTop = editor.getScrollTop();
        const scrollLeft = editor.getScrollLeft();
        const lineHeight = editor.getOption(
          (monacoRef.current as Monaco).editor.EditorOption.lineHeight,
        );
        const charWidth = 7.2;
        const top = (line - 1) * lineHeight - scrollTop - 20;
        const left =
          layoutInfo.contentLeft + (column - 1) * charWidth - scrollLeft;
        tag.style.top = `${Math.max(0, top)}px`;
        tag.style.left = `${Math.max(0, left)}px`;
      } catch {
        tag.style.top = "4px";
        tag.style.left = "4px";
      }
    },
    [],
  );

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get("room");
    if (!roomId) {
      setStatus("Waiting for URL");
      return;
    }

    const room = supabase.channel(roomId, {
      config: { broadcast: { self: false } },
    });

    room.on("broadcast", { event: "code-update" }, (payload) => {
      const incomingFileName = payload.payload.fileName;
      if (
        fileNameRef.current === "Waiting for VS Code..." ||
        fileNameRef.current === incomingFileName
      ) {
        isApplyingRemoteChange.current = true;
        setCode(payload.payload.newCode);
        if (incomingFileName) {
          fileNameRef.current = incomingFileName;
          setFileName(incomingFileName);
          setLanguage(getLanguageFromExtension(incomingFileName));
        }
        if (lastHostCursorRef.current) {
          setTimeout(() => {
            renderHostCursor(
              lastHostCursorRef.current!.line,
              lastHostCursorRef.current!.column,
              lastHostCursorRef.current!.userName,
            );
          }, 20);
        }
      }
    });

    room.on("broadcast", { event: "file-tree-update" }, (payload) => {
      setRawFileTree(payload.payload.files || []);
    });

    room.on("broadcast", { event: "cursor-update" }, (payload) => {
      const { line, column, userName } = payload.payload;
      lastHostCursorRef.current = { line, column, userName };
      renderHostCursor(line, column, userName);
    });

    // Receive terminal output from VS Code and write to xterm
    room.on("broadcast", { event: "terminal-output" }, (payload) => {
      const { data } = payload.payload;
      if (xtermRef.current && typeof data === "string") {
        xtermRef.current.write(data);
        if (
          data.includes("[Exited with code") ||
          data.includes("[Process killed")
        ) {
          setIsProcessRunning(false);
          xtermRef.current.write("\x1b[33m$ \x1b[0m");
        }
      }
    });

    room.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setStatus("Ready");
        room.send({ type: "broadcast", event: "request-sync", payload: {} });
        room.send({
          type: "broadcast",
          event: "request-file-tree",
          payload: {},
        });
      }
    });

    channelRef.current = room;
    return () => {
      supabase.removeChannel(room);
    };
  }, [renderHostCursor]);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.focus();

    editor.onDidChangeCursorPosition((e) => {
      const now = Date.now();
      if (now - cursorThrottleRef.current > 50) {
        cursorThrottleRef.current = now;
        if (
          channelRef.current &&
          fileNameRef.current !== "Waiting for VS Code..."
        ) {
          channelRef.current.send({
            type: "broadcast",
            event: "cursor-update-web",
            payload: {
              line: e.position.lineNumber - 1,
              column: e.position.column - 1,
              fileName: fileNameRef.current,
              userName: webUserNameRef.current,
            },
          });
        }
      }
    });

    editor.onDidScrollChange(() => {
      if (lastHostCursorRef.current) {
        renderHostCursor(
          lastHostCursorRef.current.line,
          lastHostCursorRef.current.column,
          lastHostCursorRef.current.userName,
        );
      }
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined) return;
    if (isApplyingRemoteChange.current) {
      isApplyingRemoteChange.current = false;
      return;
    }
    setCode(value);
    if (codeUpdateTimeoutRef.current)
      window.clearTimeout(codeUpdateTimeoutRef.current);
    codeUpdateTimeoutRef.current = window.setTimeout(() => {
      if (channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "code-update",
          payload: { newCode: value, fileName: fileNameRef.current },
        });
      }
    }, 500);
  };

  const requestFileOpen = (path: string) => {
    if (channelRef.current) {
      const newTargetFile = path.split("/").pop() || path;
      fileNameRef.current = newTargetFile;
      setFileName(newTargetFile);
      setCode("// Loading file from VS Code...");
      channelRef.current.send({
        type: "broadcast",
        event: "open-file",
        payload: { path },
      });
    }
  };

  const handleRefreshTree = () => {
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "request-file-tree",
        payload: {},
      });
    }
  };

  const handleKillProcess = () => {
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "kill-process",
        payload: {},
      });
      setIsProcessRunning(false);
      xtermRef.current?.write("\r\n\x1b[33m$ \x1b[0m");
    }
  };

  const treeData = buildTree(rawFileTree);
  const sortedTopLevel = Object.values(treeData).sort((a, b) => {
    if (a.isFolder === b.isFolder) return a.name.localeCompare(b.name);
    return a.isFolder ? -1 : 1;
  });

  return (
    <div
      style={{
        height: "100vh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        backgroundColor: "#1e1e1e",
      }}
    >
      <style>{`
        .remote-cursor { border-left: 2px solid #d97706 !important; margin-left: -1px; position: absolute; z-index: 10; pointer-events: none; }
        .remote-name-tag { font-family: sans-serif; font-weight: 600; letter-spacing: 0.3px; box-shadow: 0 1px 4px rgba(0,0,0,0.4); }
        .xterm-viewport::-webkit-scrollbar { width: 6px; }
        .xterm-viewport::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
        .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
      `}</style>

      {/* Header */}
      <header
        style={{
          padding: "0 24px",
          backgroundColor: "#1e1e1e",
          color: "#cccccc",
          borderBottom: "1px solid #3c3c3c",
          fontFamily: "sans-serif",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          boxSizing: "border-box",
          height: "50px",
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            style={{
              background: "none",
              border: "none",
              color: "#cccccc",
              cursor: "pointer",
              fontSize: "18px",
              padding: 0,
              display: "flex",
              alignItems: "center",
            }}
            title="Toggle Sidebar"
          >
            ☰
          </button>
          <span style={{ fontWeight: 600, letterSpacing: "0.5px" }}>
            Tameer Workspace / {fileName}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={() => setIsTerminalOpen((prev) => !prev)}
            title="Toggle Terminal"
            style={{
              background: isTerminalOpen ? "#d97706" : "none",
              border: "1px solid " + (isTerminalOpen ? "#d97706" : "#555"),
              color: isTerminalOpen ? "white" : "#cccccc",
              cursor: "pointer",
              fontSize: "12px",
              padding: "3px 10px",
              borderRadius: "4px",
              fontFamily: "sans-serif",
              letterSpacing: "0.3px",
            }}
          >
            {isTerminalOpen ? "▼ Terminal" : "▶ Terminal"}
          </button>
          <span
            style={{
              fontSize: "12px",
              padding: "4px 8px",
              backgroundColor: status === "Ready" ? "#007acc" : "#d97706",
              color: "white",
              borderRadius: "4px",
              transition: "background-color 0.3s ease",
            }}
          >
            {status}
          </span>
        </div>
      </header>

      {/* Main body */}
      <div
        style={{
          flex: 1,
          display: "flex",
          width: "100%",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            width: isSidebarOpen ? "250px" : "0px",
            minWidth: isSidebarOpen ? "250px" : "0px",
            flexShrink: 0,
            opacity: isSidebarOpen ? 1 : 0,
            backgroundColor: "#252526",
            borderRight: isSidebarOpen ? "1px solid #3c3c3c" : "none",
            overflowX: "hidden",
            overflowY: isSidebarOpen ? "auto" : "hidden",
            padding: isSidebarOpen ? "10px 0" : "0px",
            transition:
              "width 0.3s ease, min-width 0.3s ease, opacity 0.2s ease, padding 0.3s ease",
            whiteSpace: "nowrap",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0 16px 8px 16px",
            }}
          >
            <span
              style={{
                color: "#858585",
                fontSize: "11px",
                fontWeight: "bold",
                textTransform: "uppercase",
                letterSpacing: "1px",
              }}
            >
              Explorer
            </span>
            <button
              onClick={handleRefreshTree}
              style={{
                background: "none",
                border: "none",
                color: "#cccccc",
                cursor: "pointer",
                fontSize: "16px",
                padding: "0",
              }}
              title="Refresh File List"
            >
              ⟳
            </button>
          </div>
          <div style={{ paddingTop: "4px" }}>
            {sortedTopLevel.length === 0 ? (
              <div
                style={{
                  padding: "10px 16px",
                  fontSize: "12px",
                  color: "#858585",
                  fontStyle: "italic",
                }}
              >
                No files shared yet.
              </div>
            ) : (
              sortedTopLevel.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  level={0}
                  activeFileName={fileName}
                  onFileClick={requestFileOpen}
                />
              ))
            )}
          </div>
        </div>

        {/* Editor + Terminal column */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {/* Monaco Editor */}
          <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
            <Editor
              height="100%"
              width="100%"
              language={language}
              theme="vs-dark"
              value={code}
              onMount={handleEditorDidMount}
              onChange={handleEditorChange}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                wordWrap: "on",
                padding: { top: 16 },
                smoothScrolling: true,
                cursorBlinking: "smooth",
                automaticLayout: true,
              }}
            />
          </div>

          {/* Terminal Panel */}
          {isTerminalOpen && (
            <div
              style={{
                height: "280px",
                flexShrink: 0,
                backgroundColor: "#1a1a1a",
                borderTop: "1px solid #3c3c3c",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Terminal toolbar */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 12px",
                  backgroundColor: "#252526",
                  borderBottom: "1px solid #3c3c3c",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    color: "#858585",
                    fontSize: "11px",
                    fontWeight: "bold",
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    fontFamily: "sans-serif",
                  }}
                >
                  Terminal
                  {isProcessRunning && (
                    <span
                      style={{
                        marginLeft: "10px",
                        color: "#d97706",
                        fontSize: "10px",
                        fontWeight: "normal",
                      }}
                    >
                      ● running
                    </span>
                  )}
                </span>
                <div
                  style={{ display: "flex", gap: "8px", alignItems: "center" }}
                >
                  {isProcessRunning && (
                    <button
                      onClick={handleKillProcess}
                      title="Kill running process (Ctrl+C)"
                      style={{
                        background: "none",
                        border: "1px solid #f44747",
                        color: "#f44747",
                        cursor: "pointer",
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "3px",
                        fontFamily: "sans-serif",
                      }}
                    >
                      ■ Kill
                    </button>
                  )}
                  <button
                    onClick={() => {
                      xtermRef.current?.clear();
                    }}
                    title="Clear terminal"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#858585",
                      cursor: "pointer",
                      fontSize: "13px",
                      padding: "0 4px",
                    }}
                  >
                    ⊘
                  </button>
                  <button
                    onClick={() => setIsTerminalOpen(false)}
                    title="Close terminal"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#858585",
                      cursor: "pointer",
                      fontSize: "16px",
                      padding: "0 4px",
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* xterm.js mount point */}
              <div
                ref={terminalRef}
                style={{ flex: 1, overflow: "hidden", padding: "4px 8px" }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
