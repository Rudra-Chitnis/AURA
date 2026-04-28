import { useState } from "react";

const formatTime = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

const AuraAvatar = () => (
  <div
    className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold"
    style={{
      background: "radial-gradient(circle at 38% 35%, #00d4ff33, #7c3aed22)",
      border: "1px solid rgba(0,212,255,0.3)",
      color: "#00d4ff",
      fontSize: 9,
      letterSpacing: "0.05em",
    }}
  >
    A
  </div>
);

const ChatMessage = ({ message }) => {
  const { role, content, timestamp, streaming } = message;
  const isUser = role === "user";

  return (
    <div
      className={`flex gap-2.5 px-4 py-2 animate-[fade-in_0.2s_ease-out] ${
        isUser ? "flex-row-reverse" : "flex-row"
      }`}
    >
      {/* Avatar (AURA only) */}
      {!isUser && <AuraAvatar />}

      {/* Bubble */}
      <div
        className="max-w-[72%] rounded-2xl px-4 py-2.5 relative"
        style={
          isUser
            ? {
                background: "linear-gradient(135deg, #0a1a2a, #0f2035)",
                border: "1px solid rgba(0,212,255,0.2)",
                borderRadius: "18px 18px 4px 18px",
              }
            : {
                background: "rgba(21,21,42,0.9)",
                border: "1px solid rgba(30,30,53,0.8)",
                borderRadius: "18px 18px 18px 4px",
              }
        }
      >
        {/* Content */}
        <p
          className={`chat-prose ${streaming ? "typing-cursor" : ""}`}
          style={{
            color: isUser ? "#c8dff5" : "#e8e8ff",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {content || (streaming ? "" : "…")}
        </p>

        {/* Timestamp */}
        {!streaming && timestamp && (
          <p
            className="text-right mt-1"
            style={{ fontSize: 10, color: "#444466" }}
          >
            {formatTime(timestamp)}
          </p>
        )}
      </div>

      {/* User initial (user only) */}
      {isUser && (
        <div
          className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold"
          style={{
            background: "rgba(0,212,255,0.12)",
            border: "1px solid rgba(0,212,255,0.2)",
            color: "#00d4ff",
          }}
        >
          R
        </div>
      )}
    </div>
  );
};

export default ChatMessage;
