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
    case "js": return "javascript";
    case "ts": case "tsx": return "typescript";
    case "jsx": return "javascript";
    case "html": return "html";
    case "css": return "css";
    case "json": return "json";
    default: return "plaintext/unknownFile";
  }
};

export default function App() {
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const isApplyingRemoteChange = useRef<boolean>(false);
  const decorationRef = useRef<string[]>([]);
  const fileNameRef = useRef<string>("Waiting for VS Code...");

  const [status, setStatus] = useState<"Connecting" | "Ready" | "Waiting for URL">("Connecting");
  const [code, setCode] = useState<string>("");
  const [fileName, setFileName] = useState<string>("Waiting for VS Code...");
  const [language, setLanguage] = useState<string>("plaintext");
  
  // NEW: State to hold the workspace file tree
  const [fileTree, setFileTree] = useState<string[]>([]);

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
      isApplyingRemoteChange.current = true;
      setCode(payload.payload.newCode);

      if (payload.payload.fileName) {
        fileNameRef.current = payload.payload.fileName;
        setFileName(payload.payload.fileName);
        setLanguage(getLanguageFromExtension(payload.payload.fileName));
      }
    });

    // NEW: Listen for the file tree list coming from VS Code
    room.on("broadcast", { event: "file-tree-update" }, (payload) => {
      console.log(
        "🐛 [WEB] Received 'file-tree-update':",
        payload.payload.files,
      );
      setFileTree(payload.payload.files || []);
    });

    room.on("broadcast", { event: "cursor-update" }, (payload) => {
      const { line, column } = payload.payload;
      if (editorRef.current && monacoRef.current) {
        decorationRef.current = editorRef.current.deltaDecorations(
          decorationRef.current,
          [{
              range: new monacoRef.current.Range(line, column, line, column),
              options: { className: "remote-cursor", hoverMessage: { value: "Coworker" } },
          }],
        );
      }
    });

   room.subscribe((status) => {
     console.log("🐛 [WEB] Supabase Connection Status:", status);

     if (status === "SUBSCRIBED") {
       setStatus("Ready");

       console.log("🐛 [WEB] Connected! Asking VS Code for the file tree...");
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
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined) return;
    if (isApplyingRemoteChange.current) {
      isApplyingRemoteChange.current = false;
      return;
    }

    setCode(value);

    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "code-update",
        payload: { 
            newCode: value,
            fileName: fileNameRef.current 
        },
      });
    }
  };

  // NEW: Command VS Code to open a specific file
  const requestFileOpen = (path: string) => {
    if (channelRef.current) {
        channelRef.current.send({
            type: "broadcast",
            event: "open-file",
            payload: { path: path }
        });
    }
  };

  return (
    <div style={{ height: "100vh", width: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
      <header style={{ padding: "12px 24px", backgroundColor: "#1e1e1e", color: "#cccccc", borderBottom: "1px solid #3c3c3c", fontFamily: "sans-serif", display: "flex", justifyContent: "space-between", alignItems: "center", boxSizing: "border-box", height: "50px" }}>
        <span style={{ fontWeight: 600, letterSpacing: "0.5px" }}>Tameer Workspace / {fileName}</span>
        <span style={{ fontSize: "12px", padding: "4px 8px", backgroundColor: status === "Ready" ? "#007acc" : "#d97706", color: "white", borderRadius: "4px", transition: "background-color 0.3s ease" }}>
          {status}
        </span>
      </header>

      {/* NEW: Split layout for Sidebar and Editor */}
      <div style={{ flex: 1, display: "flex", width: "100%", overflow: "hidden" }}>
        
        {/* Sidebar */}
        <div style={{ width: "250px", backgroundColor: "#252526", borderRight: "1px solid #3c3c3c", overflowY: "auto", padding: "10px 0" }}>
            <div style={{ color: "#858585", fontSize: "11px", fontWeight: "bold", padding: "0 16px 8px 16px", textTransform: "uppercase", letterSpacing: "1px" }}>
                Explorer
            </div>
            <ul style={{ listStyleType: "none", padding: 0, margin: 0 }}>
                {fileTree.map((path, index) => {
                    const isSelected = path.endsWith(fileName);
                    return (
                        <li 
                            key={index}
                            onClick={() => requestFileOpen(path)}
                            style={{
                                padding: "4px 16px",
                                fontSize: "13px",
                                fontFamily: "sans-serif",
                                color: isSelected ? "#ffffff" : "#cccccc",
                                backgroundColor: isSelected ? "#37373d" : "transparent",
                                cursor: "pointer",
                                wordBreak: "break-all"
                            }}
                            onMouseEnter={(e) => { if(!isSelected) e.currentTarget.style.backgroundColor = "#2a2d2e" }}
                            onMouseLeave={(e) => { if(!isSelected) e.currentTarget.style.backgroundColor = "transparent" }}
                        >
                            {path}
                        </li>
                    )
                })}
            </ul>
        </div>

        {/* Editor */}
        <div style={{ flex: 1, position: "relative" }}>
          <Editor
            height="100%"
            width="100%"
            language={language}
            theme="vs-dark"
            value={code}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
            options={{ minimap: { enabled: false }, fontSize: 14, wordWrap: "on", padding: { top: 16 }, smoothScrolling: true, cursorBlinking: "smooth", automaticLayout: true }}
          />
        </div>
      </div>
    </div>
  );
}