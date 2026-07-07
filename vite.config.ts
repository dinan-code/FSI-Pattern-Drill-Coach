import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ttsCacheDir = join(tmpdir(), "fsi-drill-tts-cache");
const transparentGif = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string, input: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ]);
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local TTS timed out."));
    }, 10000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Local TTS exited with code ${code}.`));
      }
    });
    child.stdin.end(input, "utf8");
  });
}

async function synthesizeSpeech(text: string) {
  await mkdir(ttsCacheDir, { recursive: true });
  const cacheKey = createHash("sha1").update(text).digest("hex");
  const outputPath = join(ttsCacheDir, `${cacheKey}.wav`);

  if (existsSync(outputPath)) {
    return readFile(outputPath);
  }

  const script = `
$ErrorActionPreference = 'Stop'
$outputPath = ${quotePowerShell(outputPath)}
$text = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $speaker.GetInstalledVoices() |
  Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } |
  Select-Object -First 1
if ($voice) {
  $speaker.SelectVoice($voice.VoiceInfo.Name)
}
$speaker.Rate = -1
$speaker.Volume = 100
$speaker.SetOutputToWaveFile($outputPath)
$speaker.Speak($text)
$speaker.Dispose()
`;

  await runPowerShell(script, text);
  return readFile(outputPath);
}

async function speakThroughDefaultDevice(text: string) {
  const script = `
$ErrorActionPreference = 'Stop'
$text = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $speaker.GetInstalledVoices() |
  Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } |
  Select-Object -First 1
if ($voice) {
  $speaker.SelectVoice($voice.VoiceInfo.Name)
}
$speaker.Rate = -1
$speaker.Volume = 100
$speaker.SetOutputToDefaultAudioDevice()
$speaker.Speak($text)
$speaker.Dispose()
`;

  await runPowerShell(script, text);
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-windows-tts",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== "/api/tts" && url.pathname !== "/api/speak") {
            next();
            return;
          }

          if (request.method !== "GET") {
            response.statusCode = 405;
            response.end("Method not allowed");
            return;
          }

          const text = (url.searchParams.get("text") ?? "").trim();
          if (!text) {
            response.statusCode = 400;
            response.end("Missing text");
            return;
          }
          if (text.length > 500) {
            response.statusCode = 413;
            response.end("Text is too long");
            return;
          }
          if (process.platform !== "win32") {
            response.statusCode = 501;
            response.end("Local TTS fallback is only available on Windows");
            return;
          }

          try {
            if (url.pathname === "/api/speak") {
              await speakThroughDefaultDevice(text);
              response.statusCode = 200;
              response.setHeader("Content-Type", "image/gif");
              response.setHeader("Cache-Control", "no-store");
              response.end(transparentGif);
            } else {
              const audio = await synthesizeSpeech(text);
              response.statusCode = 200;
              response.setHeader("Content-Type", "audio/wav");
              response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              response.end(audio);
            }
          } catch {
            response.statusCode = 500;
            response.end("Local speech failed");
          }
        });
      }
    }
  ],
  server: {
    host: "127.0.0.1",
    port: 5177
  },
  preview: {
    host: "127.0.0.1",
    port: 4177
  }
});
