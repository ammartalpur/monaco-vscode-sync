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
      if (!current.children[part])
        current.children[part] = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isFolder: i < parts.length - 1,
          children: {},
        };
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
    const sortedChildren = Object.values(node.children).sort((a, b) =>
      a.isFolder === b.isFolder
        ? a.name.localeCompare(b.name)
        : a.isFolder
          ? -1
          : 1,
    );
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
  const fileNameRef = useRef<string>("Waiting for VS Code...");
  const lastHostCursorRef = useRef<{
    line: number;
    column: number;
    userName?: string;
    fileName?: string;
  } | null>(null);
  const webUserNameRef = useRef<string>("Web User");
  const codeUpdateTimeoutRef = useRef<number | null>(null);
  const cursorThrottleRef = useRef<number>(0);

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  // const inputBufferRef = useRef<string>("");

  const cwdRef = useRef<string>("~");
  const hostNameRef = useRef<string>("host");

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
  const isProcessRunningRef = useRef<boolean>(false);

  const setProcessRunning = (val: boolean) => {
    isProcessRunningRef.current = val;
    setIsProcessRunning(val);
  };

  const printPrompt = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.write(
        `\r\n\x1b[32m${hostNameRef.current}@tameer\x1b[0m:\x1b[34m${cwdRef.current}\x1b[0m$ `,
      );
    }
  }, []);

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
useEffect(() => {
  console.log(
    "Terminal State Changed. Open:",
    isTerminalOpen,
    "Terminal Ref:",
    !!terminalRef.current,
  );

  if (!isTerminalOpen || !terminalRef.current) return;
  if (xtermRef.current) {
    console.log("Terminal already exists, skipping initialization.");
    return;
  }

  try {
    console.log("Initializing xterm.js...");
    const term = new Terminal({
      theme: {
        background: "#1a1a1a",
        foreground: "#d4d4d4",
        cursor: "#d97706",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#6a9955",
        yellow: "#d97706",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#9cdcfe",
        white: "#d4d4d4",
      },
      fontFamily: '"Cascadia Code", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    xtermRef.current = term;

    term.writeln("\x1b[33mTerminal Initialized...\x1b[0m");
    printPrompt();

    console.log("Terminal successfully opened.");
  } catch (err) {
    console.error("FAILED TO INITIALIZE TERMINAL:", err);
  }
}, [isTerminalOpen, printPrompt]);

  const renderHostCursor = useCallback(
    (
      line: number,
      column: number,
      userName?: string,
      cursorFileName?: string,
    ) => {
      if (!editorRef.current || !monacoRef.current) return;
      const editor = editorRef.current;
      const model = editor.getModel();

      if (model) {
        const ghostDecorations = model
          .getAllDecorations()
          .filter((d) => d.options.className === "remote-cursor")
          .map((d) => d.id);
        editor.deltaDecorations(ghostDecorations, []);
      }

      const existingTag = document.getElementById("tameer-host-name-tag");
      if (cursorFileName && cursorFileName !== fileNameRef.current) {
        if (existingTag) existingTag.style.display = "none";
        return;
      }

      editor.deltaDecorations(
        [],
        [
          {
            range: new monacoRef.current.Range(line, column, line, column),
            options: { className: "remote-cursor" },
          },
        ],
      );

      const editorDom = editor.getDomNode();
      if (!editorDom) return;

      let tag = document.getElementById("tameer-host-name-tag");
      if (!tag) {
        tag = document.createElement("div");
        tag.id = "tameer-host-name-tag";
        tag.className = "remote-name-tag";
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
      }

      tag.style.display = "block";
      tag.innerText = userName ? `${userName} (Host)` : "VS Code Host";

      try {
        const layoutInfo = editor.getLayoutInfo();
        const top =
          (line - 1) *
            editor.getOption(
              (monacoRef.current as Monaco).editor.EditorOption.lineHeight,
            ) -
          editor.getScrollTop() -
          20;
        const left =
          layoutInfo.contentLeft + (column - 1) * 7.2 - editor.getScrollLeft();
        tag.style.top = `${Math.max(0, top)}px`;
        tag.style.left = `${Math.max(0, left)}px`;
      } catch {}
    },
    [],
  );

  useEffect(() => {
    const roomId = new URLSearchParams(window.location.search).get("room");
    if (!roomId) return setStatus("Waiting for URL");

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
        if (lastHostCursorRef.current)
          setTimeout(
            () =>
              renderHostCursor(
                lastHostCursorRef.current!.line,
                lastHostCursorRef.current!.column,
                lastHostCursorRef.current!.userName,
                lastHostCursorRef.current!.fileName,
              ),
            20,
          );
      }
    });

    room.on("broadcast", { event: "file-tree-update" }, (payload) =>
      setRawFileTree(payload.payload.files || []),
    );

    room.on("broadcast", { event: "cursor-update" }, (payload) => {
      lastHostCursorRef.current = payload.payload;
      renderHostCursor(
        payload.payload.line,
        payload.payload.column,
        payload.payload.userName,
        payload.payload.fileName,
      );
    });

    room.on("broadcast", { event: "terminal-output" }, (payload) => {
      if (xtermRef.current && typeof payload.payload.data === "string") {
        xtermRef.current.write(payload.payload.data);
      }
    });

    room.on("broadcast", { event: "process-ended" }, () => {
      setProcessRunning(false);
      printPrompt();
    });

    room.on("broadcast", { event: "cwd-update" }, (payload) => {
      cwdRef.current = payload.payload.cwd;
      hostNameRef.current = payload.payload.hostName || "host";
    });

    room.on("broadcast", { event: "terminal-clear" }, () => {
      xtermRef.current?.clear();
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
  }, [renderHostCursor, printPrompt]);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.focus();

    editor.onDidChangeCursorPosition((e) => {
      if (Date.now() - cursorThrottleRef.current > 50) {
        cursorThrottleRef.current = Date.now();
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
      if (lastHostCursorRef.current)
        renderHostCursor(
          lastHostCursorRef.current.line,
          lastHostCursorRef.current.column,
          lastHostCursorRef.current.userName,
          lastHostCursorRef.current.fileName,
        );
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined || isApplyingRemoteChange.current) {
      isApplyingRemoteChange.current = false;
      return;
    }
    setCode(value);
    if (codeUpdateTimeoutRef.current)
      window.clearTimeout(codeUpdateTimeoutRef.current);
    codeUpdateTimeoutRef.current = window.setTimeout(() => {
      if (channelRef.current)
        channelRef.current.send({
          type: "broadcast",
          event: "code-update",
          payload: { newCode: value, fileName: fileNameRef.current },
        });
    }, 500);
  };

  const handleKillProcess = () => {
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "kill-process",
        payload: {},
      });
    }
  };

  const treeData = buildTree(rawFileTree);
  const sortedTopLevel = Object.values(treeData).sort((a, b) =>
    a.isFolder === b.isFolder
      ? a.name.localeCompare(b.name)
      : a.isFolder
        ? -1
        : 1,
  );

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
      <style>{`.remote-cursor { border-left: 2px solid #d97706 !important; margin-left: -1px; position: absolute; z-index: 10; pointer-events: none; } .remote-name-tag { font-family: sans-serif; font-weight: 600; letter-spacing: 0.3px; box-shadow: 0 1px 4px rgba(0,0,0,0.4); } .xterm-viewport::-webkit-scrollbar { width: 6px; } .xterm-viewport::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; } .xterm-viewport::-webkit-scrollbar-track { background: transparent; }`}</style>
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
          height: "50px",
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
            }}
            title="Toggle Sidebar"
          >
            ☰
          </button>
          <span style={{ fontWeight: 600 }}>Tameer Workspace / {fileName}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={() => setIsTerminalOpen((prev) => !prev)}
            style={{
              background: isTerminalOpen ? "#d97706" : "none",
              border: "1px solid " + (isTerminalOpen ? "#d97706" : "#555"),
              color: isTerminalOpen ? "white" : "#cccccc",
              cursor: "pointer",
              fontSize: "12px",
              padding: "3px 10px",
              borderRadius: "4px",
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
            }}
          >
            {status}
          </span>
        </div>
      </header>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div
          style={{
            width: isSidebarOpen ? "250px" : "0px",
            minWidth: isSidebarOpen ? "250px" : "0px",
            backgroundColor: "#252526",
            borderRight: isSidebarOpen ? "1px solid #3c3c3c" : "none",
            overflow: "hidden",
            transition: "width 0.3s ease",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "10px 16px",
            }}
          >
            <span
              style={{
                color: "#858585",
                fontSize: "11px",
                fontWeight: "bold",
                textTransform: "uppercase",
              }}
            >
              Explorer
            </span>
            <button
              onClick={() =>
                channelRef.current?.send({
                  type: "broadcast",
                  event: "request-file-tree",
                  payload: {},
                })
              }
              style={{
                background: "none",
                border: "none",
                color: "#cccccc",
                cursor: "pointer",
                fontSize: "16px",
              }}
            >
              ⟳
            </button>
          </div>
          <div>
            {sortedTopLevel.length === 0 ? (
              <div style={{ padding: "10px 16px", color: "#858585" }}>
                No files shared.
              </div>
            ) : (
              sortedTopLevel.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  level={0}
                  activeFileName={fileName}
                  onFileClick={(path) => {
                    setFileName(path.split("/").pop() || path);
                    setCode("// Loading...");
                    channelRef.current?.send({
                      type: "broadcast",
                      event: "open-file",
                      payload: { path },
                    });
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <Editor
              height="100%"
              language={language}
              theme="vs-dark"
              value={code}
              onMount={handleEditorDidMount}
              onChange={handleEditorChange}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                wordWrap: "on",
              }}
            />
          </div>
          {isTerminalOpen && (
            <div
              style={{
                height: "280px",
                backgroundColor: "#1a1a1a",
                borderTop: "1px solid #3c3c3c",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "4px 12px",
                  backgroundColor: "#252526",
                }}
              >
                <span
                  style={{
                    color: "#858585",
                    fontSize: "11px",
                    fontWeight: "bold",
                    textTransform: "uppercase",
                  }}
                >
                  Terminal{" "}
                  {isProcessRunning && (
                    <span style={{ color: "#d97706" }}>● running</span>
                  )}
                </span>
                <div style={{ display: "flex", gap: "8px" }}>
                  {isProcessRunning && (
                    <button
                      onClick={handleKillProcess}
                      style={{
                        background: "none",
                        border: "1px solid #f44747",
                        color: "#f44747",
                        cursor: "pointer",
                        fontSize: "11px",
                        borderRadius: "3px",
                      }}
                    >
                      ■ Kill
                    </button>
                  )}
                  <button
                    onClick={() => setIsTerminalOpen(false)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#858585",
                      cursor: "pointer",
                      fontSize: "16px",
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
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
