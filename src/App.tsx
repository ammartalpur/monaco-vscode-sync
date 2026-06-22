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
      return "typescript";
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

export default function App() {
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const isApplyingRemoteChange = useRef<boolean>(false);
  const decorationRef = useRef<string[]>([]);

  const [status, setStatus] = useState<
    "Connecting" | "Ready" | "Waiting for URL"
  >("Connecting");
  const [code, setCode] = useState<string>("");

  // Start with empty/generic states since VS Code will tell us what file this is
  const [fileName, setFileName] = useState<string>("Waiting for VS Code...");
  const [language, setLanguage] = useState<string>("plaintext");

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

      // UPDATE THE UI IF A NEW FILE IS OPENED IN VS CODE
      if (payload.payload.fileName) {
        setFileName(payload.payload.fileName);
        setLanguage(getLanguageFromExtension(payload.payload.fileName));
      }
    });

    room.on("broadcast", { event: "cursor-update" }, (payload) => {
      const { line, column } = payload.payload;
      if (editorRef.current && monacoRef.current) {
        decorationRef.current = editorRef.current.deltaDecorations(
          decorationRef.current,
          [
            {
              range: new monacoRef.current.Range(line, column, line, column),
              options: {
                className: "remote-cursor",
                hoverMessage: { value: "Coworker" },
              },
            },
          ],
        );
      }
    });

    room.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setStatus("Ready");
        room.send({ type: "broadcast", event: "request-sync", payload: {} });
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

    if (channelRef.current && status === "Ready") {
      channelRef.current.send({
        type: "broadcast",
        event: "code-update",
        payload: { newCode: value },
      });
    }
  };

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
      <header
        style={{
          padding: "12px 24px",
          backgroundColor: "#252526",
          color: "#cccccc",
          borderBottom: "1px solid #3c3c3c",
          fontFamily: "sans-serif",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          boxSizing: "border-box",
          height: "50px",
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: "0.5px" }}>
          Tameer / {fileName}
        </span>
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

      <div style={{ flex: 1, width: "100%", position: "relative" }}>
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
  );
}
