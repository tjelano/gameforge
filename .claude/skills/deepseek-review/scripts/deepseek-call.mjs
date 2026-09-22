#!/usr/bin/env node
// Sends one turn to a DeepSeek-model chat-completions endpoint (OpenRouter by
// default, CheaperInference as a fallback) and appends both the new user
// message and the reply to a JSON history file, so the
// next call resends full history — this is the "resume the same thread" mechanic,
// since a plain chat-completions API has no server-side session state like Codex's
// `codex exec resume`.
//
// Usage: node deepseek-call.mjs <history-file> <message-file> [--system <system-file>]
// Env:   DEEPSEEK_REVIEW_PROVIDER (default openrouter; set to "cheaperinference" to switch back)
//   openrouter (default, 2026-09-22 -- CheaperInference has had repeated real
//   flakiness this project, OpenRouter has been 100% reliable in every real
//   call so far):
//     OPENROUTER_API_KEY (required)
//     OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1/chat/completions)
//     OPENROUTER_MODEL (default deepseek/deepseek-v4.1-flash) -- also used as
//       the first entry in a `models` fallback list (see OPENROUTER_FALLBACK_MODEL
//       below); OpenRouter tries the next entry automatically if the first
//       errors, no client-side retry loop needed.
//   cheaperinference:
//     CHEAPERINFERENCE_API_KEY (required)
//     CHEAPERINFERENCE_BASE_URL (default https://api.cheaperinference.com/v1/chat/completions)
//     CHEAPERINFERENCE_MODEL (default deepseek-v4-flash)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Uses process.exitCode + return (never process.exit()) on every error path.
// Found the hard way: process.exit() called right after a fetch() response
// still has undici's keep-alive socket/timer handles mid-teardown on Windows
// — Node crashes with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
// instead of exiting with the intended code. Letting the event loop drain
// naturally avoids the race entirely.
async function main() {
  const [historyFile, messageFile, flag, systemFile] = process.argv.slice(2);

  if (!historyFile || !messageFile) {
    console.error("Usage: deepseek-call.mjs <history-file> <message-file> [--system <system-file>]");
    process.exitCode = 2;
    return;
  }

  const useOpenRouter = process.env.DEEPSEEK_REVIEW_PROVIDER !== "cheaperinference";

  const apiKey = useOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.CHEAPERINFERENCE_API_KEY;
  if (!apiKey) {
    console.error(useOpenRouter ? "OPENROUTER_API_KEY is not set in this shell." : "CHEAPERINFERENCE_API_KEY is not set in this shell.");
    process.exitCode = 2;
    return;
  }

  const baseUrl = useOpenRouter
    ? (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1/chat/completions")
    : (process.env.CHEAPERINFERENCE_BASE_URL || "https://api.cheaperinference.com/v1/chat/completions");
  const model = useOpenRouter
    ? (process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash")
    : (process.env.CHEAPERINFERENCE_MODEL || "deepseek-v4-flash");

  // The API key rides in an Authorization header on every call -- a plain-http
  // baseUrl (only reachable via a misconfigured OPENROUTER_BASE_URL /
  // CHEAPERINFERENCE_BASE_URL override, the defaults above are both https)
  // would send it in cleartext. Check before it's ever used.
  if (!/^https:\/\//i.test(baseUrl)) {
    console.error(`Refusing to send the API key to a non-HTTPS URL: ${baseUrl}. Check ${useOpenRouter ? "OPENROUTER_BASE_URL" : "CHEAPERINFERENCE_BASE_URL"}.`);
    process.exitCode = 2;
    return;
  }

  // OpenRouter-only: a `models` array (replaces the singular `model` field
  // entirely -- that's OpenRouter's own documented shape for this) makes
  // OpenRouter automatically try the next entry if the first errors, no
  // client-side retry loop needed. Falls back to the older, verified-real
  // v4-flash slug -- stays within the DeepSeek family rather than jumping to
  // an unrelated vendor, so a fallback response is still recognizably the
  // same critic. Skipped if the resolved model already IS the fallback
  // (an explicit OPENROUTER_MODEL override), to avoid a redundant duplicate.
  const OPENROUTER_FALLBACK_MODEL = "deepseek/deepseek-v4-flash";
  const models = useOpenRouter && model !== OPENROUTER_FALLBACK_MODEL
    ? [model, OPENROUTER_FALLBACK_MODEL]
    : undefined;

  // Any 3rd argument other than exactly "--system" (a typo like --sytem, or
  // a stray value) has the same silent-failure shape as the check below: the
  // system-prompt branch further down only matches the literal string
  // "--system", so anything else silently drops systemFile on the floor with
  // no system prompt attached and no error.
  if (flag !== undefined && flag !== "--system") {
    console.error(`Unrecognized third argument "${flag}" -- only --system is supported.`);
    process.exitCode = 2;
    return;
  }

  // A --system flag with no path after it (dropped or misplaced argument)
  // must not fall through silently: without this check neither branch below
  // fires, history stays empty, and the call proceeds with no system prompt
  // at all -- an "adversarial review" indistinguishable from one that ran
  // with no mandate, and no error to say so.
  if (flag === "--system" && !systemFile) {
    console.error("--system requires a system-file path argument.");
    process.exitCode = 2;
    return;
  }

  // --system is only meaningful for a fresh Round 1. If historyFile already
  // exists, a caller passing --system almost always means a stale file
  // wasn't deleted first (SKILL.md's own "delete before Round 1" rule) --
  // silently ignoring --system in that case would run the critic with no
  // adversarial mandate at all, no sign anything went wrong. Stop instead.
  if (flag === "--system" && existsSync(historyFile)) {
    console.error(`${historyFile} already exists, but --system was passed. Delete it first for a fresh Round 1, or omit --system to resume the existing thread.`);
    process.exitCode = 2;
    return;
  }

  let history = [];
  if (existsSync(historyFile)) {
    let historyText;
    try {
      historyText = readFileSync(historyFile, "utf8");
      const parsed = JSON.parse(historyText);
      if (!Array.isArray(parsed)) {
        throw new Error("history file's JSON root is not an array");
      }
      history = parsed;
    } catch (e) {
      console.error(`${historyFile} exists but could not be read as valid JSON (${e.message}). Delete it to start a fresh review, or restore it from a backup.`);
      process.exitCode = 2;
      return;
    }
  } else if (flag === "--system" && systemFile) {
    history.push({ role: "system", content: readFileSync(systemFile, "utf8") });
  }

  history.push({ role: "user", content: readFileSync(messageFile, "utf8") });

  // 10 minutes: a real 108KB/14-task plan review (high-effort reasoning,
  // OpenRouter) genuinely took longer than an earlier 5-minute bound allowed
  // -- that wasn't a hang, just a big-enough job. Still bounded so a truly
  // dead connection doesn't stall the session forever with no feedback.
  const PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;

  let bodyText;
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      // A redirect response would otherwise be followed automatically
      // (fetch's default), silently carrying the Authorization header's API
      // key to whatever host the redirect points at -- refuse instead.
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(useOpenRouter ? { "HTTP-Referer": "https://github.com/tjelano/gameforge", "X-Title": "GameForge deepseek-review" } : {}),
      },
      body: JSON.stringify({
        ...(models ? { models } : { model }),
        messages: history,
        // Explicit, not left to whatever OpenRouter's per-model default
        // happens to be: DeepSeek V4.1 Flash's own API defaults its thinking
        // mode to high effort, but that's not guaranteed to survive
        // OpenRouter's pass-through unless asked for directly.
        ...(useOpenRouter ? { reasoning: { effort: "high" } } : {}),
      }),
    });
    // The abort signal guards the whole request lifecycle, including
    // streaming the response body -- res.text() must stay inside this same
    // try, not after it. A large/slow response can abort mid-body-read even
    // after fetch() itself already resolved with headers, and that threw
    // uncaught here once for real (a 108KB plan review) before this fix.
    bodyText = await res.text();
    if (!res.ok) {
      console.error(`DeepSeek call failed: HTTP ${res.status}\n${bodyText}`);
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    console.error(`DeepSeek call failed: ${e.name === "TimeoutError" ? `no response after ${PROVIDER_TIMEOUT_MS / 1000}s` : e.message}`);
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    console.error(`DeepSeek returned non-JSON response:\n${bodyText}`);
    process.exitCode = 1;
    return;
  }

  const reply = data.choices?.[0]?.message?.content;
  if (!reply) {
    console.error(`DeepSeek response had no message content:\n${bodyText}`);
    process.exitCode = 1;
    return;
  }

  // To stderr, not stdout -- stdout is the critic's reply itself, meant to
  // be captured verbatim. Printed even on the non-fallback path so it's
  // always visible which model actually answered, not just when the
  // `models` fallback silently kicks in (see SKILL.md's "Known quirk" note
  // on trusting this field over the model's own self-report).
  console.error(`(model: ${data.model ?? "unknown"})`);

  history.push({ role: "assistant", content: reply });
  writeFileSync(historyFile, JSON.stringify(history, null, 2));

  process.stdout.write(reply);
}

await main();
