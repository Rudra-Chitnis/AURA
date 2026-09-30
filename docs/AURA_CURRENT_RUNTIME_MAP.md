# AURA — Current Runtime Map

> This document describes what AURA ACTUALLY does today.
> It is an architectural observation document, not a target design.
>
> Branch: aura-core
> Stable reference: aura-v2
>
> Do not treat this document as permission to rewrite or remove existing systems.

---

## 1. Runtime Domains

AURA currently consists of several cooperating runtime domains:

1. Electron Desktop Runtime
2. React Renderer
3. Node.js Backend
4. Python Voice Runtime
5. Ollama
6. MongoDB

The Electron main process currently acts as the primary runtime supervisor.

---

## 2. Current Process Topology

```text
start.bat
   |
   v
Electron
   |
   +--------------------+
   |                    |
   v                    v
Node Backend        Python Voice
   |                    |
   |                    +-- Whisper
   |                    +-- TTS
   |                    +-- Audio
   |
   +-- MongoDB
   +-- Embeddings
   +-- AI Service
   +-- Reminder Scheduler
   +-- WebSocket Hub
   |
   +--------------------------+
                              |
                            Ollama
                              |
                             LLM