// server.ts
// ------------------------ Core & deps ------------------------
import { Result } from "../node_modules/typechat/dist/result";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import express from "express";
import * as WebSocket from 'ws';    // ws cleverly exports both a class and a namespace; make it act normal
import { WebSocketServer } from 'ws';

// ------------------------ Env ------------------------

dotenv.config();          // could use find-config to be smarter about locating .env, but our setup is simple enough

if (process.env.OPENAI_API_KEY === undefined) {
  console.log("No OpenAI API key found in .env file. Exiting.");
  process.exit(1);
}

// ------------------------ TypeChat ------------------------

import { createAzureOpenAILanguageModel } from "typechat";          // wrapper for Azure OpenAI

import { createTypeScriptJsonValidator } from "typechat/ts";        // TS-based JSON schema validator

import { Island } from "./io_schema";                               // our schema type  

import { createMythographer } from "./mythographer";                 // our Mythographer translator, adapted from typechat's json translator
                                                                     // our version doesn't repair automatically but rather exposes repair() separately
                                                                     // also adds a modify() that facilitates targeted changes to existing json


// ------------------------ Setup ------------------------

// Create LLM model wrapper (Azure OpenAI GPT-4o deployment URL)
const model = createAzureOpenAILanguageModel(
  process.env.OPENAI_API_KEY,
  "https://mythogen.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2023-03-15-preview"     // todo: change to the gpt-5 deployment

);

// Load schema from typescript source. we will use this to generate the json schema internally and to create the atuo-repair prompts
const viewSchema = fs.readFileSync(
  path.join(__dirname, "io_schema.ts"),
  "utf8"
);

// the validator can tell you if a json blob matches the schema or not
const validator = createTypeScriptJsonValidator<Island>(viewSchema, "Island");

// Create Mythographer translator -> user prompt to world design json
const translator = createMythographer(model, validator);

// ------------------------ Express (health / misc) ------------------------

const app = express();
app.set("json spaces", 2);


// Basic health/pulse endpoint
app.get("/", (_, res) => {
  res.json({
    status: "ok",
    message: "MythOS WebSocket server is running. Use WS for work.",
  });
});

// ------------------------ HTTP server ------------------------
const port = 3000;
const server = app.listen(port, () =>
  console.log("Starting MythOS server on port", port)
);

server.timeout = 3600000;
server.keepAliveTimeout = 3600000;

// ------------------------ WebSocket layer ------------------------
// Message protocol (client -> server)
type ClientPrompt = { type: "prompt"; prompt: string };
type ClientModify = { type: "modify"; prompt: string, originalJson: Island };
type ClientCancel = { type: "cancel" };
type ClientPing = { type: "ping" };
type ClientMessage = ClientPrompt | ClientModify | ClientCancel | ClientPing;

type stageName = "received" | "translating" | "modifying" | "validating" | "repair" | "idle";
// Event protocol (server -> client)
// Here we define what the server can send back to the client
type EvStatus = {
  event: "status";
  stage: stageName;
  message: string;
  attempt?: number;
};

// core result will be of type Island, but we use unknown here to keep it flexible
type EvResult = { event: "result"; data: unknown; is_modify?: boolean };

// a partial result has some non-compliance with the schema but is likely useful
type EvResultPartial = { event: "result_partial"; data: unknown; message: string ; is_modify?: boolean};

type EvError = { event: "error"; message: string };
type EvDone = { event: "done"; ok: boolean };
type EvPong = { event: "pong"; t: number };

type ServerEvent = EvStatus | EvResult | EvResultPartial | EvError | EvDone | EvPong;

// Per-connection runtime state
type SocketState = {
  busy: boolean;                  // prevent concurrent jobs on one socket
  canceled: boolean;              // allows client-side cancel, although we can't truly abort the LLM call
  jobName: EvStatus["stage"];     // optional job name for logging
  lastJobId: number;              // monotonic id for in-flight job
  heartbeat?: NodeJS.Timeout;
};

function send(ws: WebSocket, payload: ServerEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendStatus(ws: WebSocket, state: SocketState, stage: stageName, message: string, data?: any) {
  const event = "status";
  send(ws, { event, stage, message, ...data });
  console.log(`Sent status: [${stage}] ${message}`);
  state.jobName = stage;
}

// =============================================
// 🔷 Main job orchestration
// =============================================

/**
 * Runs a translation job end-to-end:
 *  1. Checks for cancellation or staleness
 *  2. Marks the worker busy
 *  3. Calls translator.translate(prompt)
 *  4. Validates and attempts repair if needed
 *  5. Reports progress and results over WebSocket
 */
async function runJob(
  ws: WebSocket,
  state: SocketState,
  jobId: number,
  prompt: string
): Promise<void> {
  const isStale = makeStaleChecker(state, jobId);

  try {
    if (isStale()) return;
    setBusy(state, true);
    state.jobName = "translating";

    sendStatus(ws, state, "received", "Prompt received.");
    sendStatus(ws, state, "translating", "Starting translation to schema...");
    console.info(`[runJob:${jobId}] Starting translation for prompt...`);

    // Main translation step — may take minutes
    let translation_result: Result<Island>;
    try {
      translation_result = await withTimeout(translator.translate(prompt), 180_000);
    } catch (err: any) {
      throw new Error(`Translation failed: ${err.message}`);
    }

    // Stop quietly if canceled mid-translation
    if (isStale()) return;

    // Bail early if the model failed to produce any valid JSON
    if (!translation_result.success) {
      sendError(ws, translation_result.message);
      return;
    }

    // Proceed to schema validation & repair
    let finalResult = await withTimeout(validateAndRepair(ws, state, jobId, translation_result.data, false), 180_000);
    if(finalResult.success === true) {
      send(ws, { event: "result", data: finalResult.data });
    }
  } catch (err: any) {
    sendError(ws, err.message);
  } finally {
    // Always clean up so the system can accept new jobs
    setBusy(state, false);
    state.jobName = "idle";
    send(ws, { event: "done", ok: !state.canceled });
  }
}


async function runModificationJob(
  ws: WebSocket,
  state: SocketState,
  jobId: number,
  prompt: string,
  previousJson: Island,
): Promise<void> {
  const isStale = makeStaleChecker(state, jobId);

  try {
    if (isStale()) return;
    setBusy(state, true);
    state.jobName = "modifying";

    sendStatus(ws, state, "received", "Prompt received.");
    sendStatus(ws, state, "modifying", "Starting modification to schema...");
    console.info(`[runJob:${jobId}] Starting modification for prompt...`);

    // Main translation step — may take minutes
    let translation_result: Result<Island>;
    try {
      translation_result = await withTimeout(translator.modify(previousJson, prompt), 180_000);
    } catch (err: any) {
      throw new Error(`Modification failed: ${err.message}`);
    }

    // Stop quietly if canceled mid-translation
    if (isStale()) return;

    // Bail early if the model failed to produce any valid JSON
    if (!translation_result.success) {
      sendError(ws, translation_result.message);
      return;
    }

    // Proceed to schema validation & repair
    let finalResult = await(withTimeout(validateAndRepair(ws, state, jobId, translation_result.data, true), 180_000));
    if(finalResult.success === true) {
      send(ws, { event: "result", data: finalResult.data, is_modify: true });
    }
  } catch (err: any) {
    sendError(ws, err.message);
  } finally {
    // Always clean up so the system can accept new jobs
    setBusy(state, false);
    state.jobName = "idle";
    send(ws, { event: "done", ok: !state.canceled });
  }
}




// =============================================
// 🔷 Validation + Repair loop
// =============================================

/**
 * Ensures translated JSON conforms to schema.
 * Tries up to 3 repair attempts using translator.repair().
 * Sends intermediate updates and partial results when repair fails.
 */
async function validateAndRepair(
  ws: WebSocket,
  state: SocketState,
  jobId: number,
  json: Island,
  is_modify: boolean,
): Promise<Result<Island>> {
  const isStale = makeStaleChecker(state, jobId);
  let current = json;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isStale()) return { success: false, message: "Job stale or canceled during validation." };

    sendStatus(ws, state, "validating", `Validating schema (attempt ${attempt})`);

    const validation = translator.json_is_schema_valid(current);

    // ✅ Schema compliance achieved
    if (validation.success) {
      console.info(`[validate:${jobId}] Schema valid on attempt ${attempt}`);
      console.info(`returning good result: \n ${JSON.stringify(current, null, 2)}`);
      return { success: true, data: current };
    }

    // ❌ Validation failed; handle depending on attempt count
    if (attempt === maxAttempts) {
      send(ws, {
        event: "result_partial",
        data: current,
        message: `Max repair attempts reached. Last error: ${validation.message}`,
        is_modify: is_modify
      });
      break;
    }

    // Attempt automated repair
    sendStatus(ws, state, "repair", `Repairing (${attempt}/3): ${validation.message}`);

    let repair_result: Result<Island>;
    try {
      repair_result = await (withTimeout (translator.repair(current, validation.message), 180_000));

      if (!repair_result.success) {
        // Catastrophic repair failure (no JSON at all) - return last valid json, which has schema errors but is coherent otherwise
        send(ws, {
          event: "result_partial",
          data: current,
          message: `Repair ${attempt} failed: ${repair_result.message}`,
          is_modify: is_modify
        });
        break;
      }

      // Store the repaired JSON and loop to re-validate
      current = repair_result.data;
      await sleep(500); // small backoff before re-validation
    } catch (err: any) {
      send(ws, { event: "error", message: `Repair ${attempt} threw: ${err.message}` });
      break;
    }
  }
  return { success: false, message: "Validation and repair loop exited unexpectedly."};
}

// =============================================
// 🔷 Utility helpers
// =============================================

/** Returns a closure that can check if the job is stale or canceled */
function makeStaleChecker(state: SocketState, id: number) {
  return () => state.canceled || id !== state.lastJobId;
}

/** Simple busy-state setter */
function setBusy(state: SocketState, busy: boolean) {
  state.busy = busy;
}

/** Centralized error emitter so we only send structured messages */
function sendError(ws: WebSocket, message: string) {
  console.error("[JobError]", message);
  send(ws, { event: "error", message });
  send(ws, { event: "done", ok: false });
}

/** Small delay utility (used for pacing repair attempts) */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Wraps an async operation with a timeout.
 * If the operation hangs beyond `ms`, it rejects with a timeout error.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Operation timed out")), ms)
  );
  return Promise.race([p, timeout]);
}



// Attach WS server to the existing HTTP server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  const state: SocketState = { busy: false, canceled: false, lastJobId: 0 , jobName: "idle"};

  // Heartbeat/keepalive (helps with proxies/timeouts)
  state.heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      // send a minimal keepalive as a status "idle" event
      send(ws, { event: "status", stage: state.jobName, message: "..." });
    }
  }, 15000);

  ws.on("message", async (raw: WebSocket.RawData) => {
    let msg: ClientMessage | undefined;
    let rawStr = raw.toString();

    try {
      console.log("Received message:", rawStr);
      msg = JSON.parse(rawStr) as ClientMessage;
    } catch {
      send(ws, { event: "error", message: "Design Server: Invalid JSON in message from client" });
      return;
    }

    if (msg.type === "ping") {
      send(ws, { event: "pong", t: Date.now() });
      return;
    }

    if (msg.type === "cancel") {
      if (state.busy) {
        state.canceled = true;
        // We can't truly abort translate() without upstream support; we just stop emitting any further events
        // translate, modify, and repair are all awaited with cancellation checks in between steps
        // you can't cancel mid-translate (at the moment) but you can prevent further processing
        sendStatus(ws, state, "idle", "Job canceled by client.");
      } else {
        sendStatus(ws, state, "idle", "No active job to cancel.");
      }
      return;
    }

    if (msg.type === "prompt") {
      const prompt = (msg.prompt ?? "").trim();
      if (!prompt) {
        send(ws, { event: "error", message: "Missing 'prompt'." });
        send(ws, { event: "done", ok: false });
        return;
      }

      if (state.busy) {
        send(ws, { event: "error", message: "Job already in progress on this connection." });
        return;
      }

      // Start a new job id
      const jobId = ++state.lastJobId;
      runJob(ws, state, jobId, prompt);
      return;
    }

    if(msg.type === "modify") {
      const prompt = (msg.prompt ?? "").trim();
      if (!prompt) {
        send(ws, { event: "error", message: "Missing 'prompt'." });
        send(ws, { event: "done", ok: false });
        return;
      }
      if (state.busy) {
        send(ws, { event: "error", message: "Job already in progress on this connection." });
        return;
      }
      const previousJson = msg.originalJson;
      if (!previousJson) {
        send(ws, { event: "error", message: "Missing 'originalJson'." });
        send(ws, { event: "done", ok: false });
        return;
      }
      // Start a new job id
      const jobId = ++state.lastJobId;
      runModificationJob(ws, state, jobId, prompt, previousJson);
      return;
    } 

    // Fallback for unknown message types
    send(ws, { event: "error", message: "Unknown message type." });
  });

  ws.on("close", () => {
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.canceled = true;
  });

  ws.on("error", (err) => {
    console.warn("WS error:", err);
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.canceled = true;
  });
});

console.log("WebSocket server attached (ws://<host>:" + port + ")");
