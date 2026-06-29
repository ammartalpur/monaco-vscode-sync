import { useState, useRef, useEffect } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";

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
  const decorationRef = useRef<string[]>([]);
  const fileNameRef = useRef<string>("Waiting for VS Code...");
  const lastHostCursorRef = useRef<{ line: number; column: number } | null>(
    null,
  );

  // --- NEW: Optimization Refs ---
  const codeUpdateTimeoutRef = useRef<number | null>(null);
  const cursorThrottleRef = useRef<number>(0);

  const [status, setStatus] = useState<
    "Connecting" | "Ready" | "Waiting for URL"
  >("Connecting");
  const [code, setCode] = useState<string>("");
  const [fileName, setFileName] = useState<string>("Waiting for VS Code...");
  const [language, setLanguage] = useState<string>("plaintext");
  const [rawFileTree, setRawFileTree] = useState<string[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  const renderHostCursor = (line: number, column: number) => {
    if (editorRef.current && monacoRef.current) {
      decorationRef.current = editorRef.current.deltaDecorations(
        decorationRef.current,
        [
          {
            range: new monacoRef.current.Range(line, column, line, column),
            options: {
              className: "remote-cursor",
              hoverMessage: { value: "VS Code Host" },
            },
          },
        ],
      );
    }
  };

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
            );
          }, 20);
        }
      }
    });

    room.on("broadcast", { event: "file-tree-update" }, (payload) => {
      setRawFileTree(payload.payload.files || []);
    });

    room.on("broadcast", { event: "cursor-update" }, (payload) => {
      const { line, column } = payload.payload;
      lastHostCursorRef.current = { line, column };
      renderHostCursor(line, column);
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
  }, []);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.focus();

    editor.onDidChangeCursorPosition((e) => {
      const now = Date.now();

      // OPTIMIZATION: Throttle cursor to 50ms intervals
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
            },
          });
        }
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

    // OPTIMIZATION: Debounce text updates (500ms delay)
    if (codeUpdateTimeoutRef.current) {
      window.clearTimeout(codeUpdateTimeoutRef.current);
    }

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
        payload: { path: path },
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
      }}
    >
      <style>{`.remote-cursor { border-left: 2px solid #d97706 !important; margin-left: -1px; position: absolute; z-index: 10; pointer-events: none; }`}</style>
      <header
        style={{
          padding: "12px 24px",
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
      </header>

      <div
        style={{ flex: 1, display: "flex", width: "100%", overflow: "hidden" }}
      >
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

        <div style={{ flex: 1, position: "relative" }}>
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
      </div>
    </div>
  );
}
