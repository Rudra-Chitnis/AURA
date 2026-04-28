import { useEffect, useRef } from "react";
import useStore from "../store/useStore";
import OrbCore from "./OrbCore";
import ChatMessage from "./ChatMessage";
import InputBar from "./InputBar";

const EmptyState = () => (
  <div className="flex-1 flex flex-col items-center justify-center gap-8 px-8 py-12">
    <OrbCore size={160} />
    <div className="text-center max-w-xs">
      <h2
        className="text-base font-semibold mb-2"
        style={{ color: "#f0f0ff", letterSpacing: "0.02em" }}
      >
        Hey, I'm AURA
      </h2>
      <p className="text-sm leading-relaxed" style={{ color: "#8888aa" }}>
        Your local AI assistant. Ask me anything, set reminders, open apps, or just talk.
        Everything stays on your device.
      </p>
    </div>
    <div className="grid grid-cols-2 gap-2 w-full max-w-xs">
      {[
        "What do you know about me?",
        "Open Spotify",
        "Remind me at 9pm to hydrate",
        "What did we talk about?",
      ].map((hint) => (
        <div
          key={hint}
          className="glass rounded-xl px-3 py-2.5 cursor-default text-center"
          style={{ fontSize: 12, color: "#8888aa" }}
        >
          {hint}
        </div>
      ))}
    </div>
  </div>
);

const ChatPanel = () => {
  const { messages, isStreaming } = useStore();
  const bottomRef  = useRef(null);
  const scrollRef  = useRef(null);
  const autoScroll = useRef(true);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Detect manual scroll up → disable auto-scroll
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    autoScroll.current = atBottom;
  };

  // Re-enable auto-scroll when streaming starts
  useEffect(() => {
    if (isStreaming) autoScroll.current = true;
  }, [isStreaming]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {hasMessages ? (
        <>
          {/* Messages area */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto py-4 space-y-0.5"
            style={{ scrollbarGutter: "stable" }}
          >
            {/* Orb — compact, top of chat */}
            <div className="flex justify-center py-6 pb-4">
              <OrbCore size={100} />
            </div>

            {/* Messages */}
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <InputBar />
        </>
      ) : (
        <>
          <EmptyState />
          <InputBar />
        </>
      )}
    </div>
  );
};

export default ChatPanel;
