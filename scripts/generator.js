import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { callLLM } from './llm.js';
import { EXPLAINROO_SYSTEM_PROMPT, buildUserPrompt } from './system-prompt.js';
import { parseScript } from '../src/script.js';

const execFileAsync = promisify(execFile);

function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Robust sanitizer for script.md and scenes.js:
 * 1. Sanitizes single braces {word} -> word, preserving {shown|spoken}
 * 2. Normalizes scene headings into clean alphanumeric IDs, e.g. "## scene1"
 * 3. Keeps scenes.js export functions synchronized with renamed scene IDs
 * 4. Pre-validates using Explainroo's parseScript parser
 */
function sanitizeScriptAndScenes(rawScript, rawScenes) {
  const lines = String(rawScript || '').split('\n');
  const seenIds = new Set();
  const idMap = new Map();
  let sceneCount = 0;

  const sanitizedLines = lines.map((line) => {
    const trimmed = line.trim();

    // 1. Scene heading line: ## or ###
    const headingMatch = /^#{2,3}\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      sceneCount++;
      const rest = headingMatch[1].trim();

      // Extract optional attributes like {hold=1.5 min=3}
      const attrMatch = /^(.*?)\s*(\{[^}]*\})\s*$/.exec(rest);
      const rawTitle = attrMatch ? attrMatch[1].trim() : rest;
      const attrSuffix = attrMatch ? ` ${attrMatch[2].trim()}` : '';

      let validId = rawTitle;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(validId)) {
        validId = rawTitle
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/[\s-]+/g, '_')
          .replace(/^_+|_+$/g, '');
      }

      if (!validId || !/^[A-Za-z0-9]/.test(validId)) {
        validId = `scene_${sceneCount}`;
      }

      // Ensure uniqueness
      let finalId = validId;
      let counter = 1;
      while (seenIds.has(finalId)) {
        finalId = `${validId}_${++counter}`;
      }
      seenIds.add(finalId);

      if (rawTitle !== finalId) {
        idMap.set(rawTitle, finalId);
      }

      return `## ${finalId}${attrSuffix}`;
    }

    // 2. Title line: # Title
    if (trimmed.startsWith('#')) {
      return line;
    }

    // 3. Narration line: sanitize malformed single braces {word} -> word, preserving {shown|spoken}
    return line.replace(/\{([^{}|]+)\}/g, '$1');
  });

  const cleanScript = sanitizedLines.join('\n') + '\n';
  let cleanScenes = String(rawScenes || '').trim();

  // Synchronize any renamed scene IDs in scenes.js
  for (const [oldId, newId] of idMap.entries()) {
    const escaped = escapeRegex(oldId);
    const oldMethodRegex = new RegExp(`(?:\\[\\s*['"\`]|['"\`]?)${escaped}(?:['"\`]\\s*\\]|['"\`]?)\\s*\\(`, 'g');
    cleanScenes = cleanScenes.replace(oldMethodRegex, `${newId}(`);
  }

  // Pre-validate with Explainroo's own parser
  try {
    parseScript(cleanScript);
  } catch (err) {
    console.warn(`[Generator] Pre-validation notice: ${err.message}`);
  }

  return { script: cleanScript, scenes: cleanScenes + '\n' };
}

async function runExplainrooCommand(args, cwd = process.cwd()) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(cwd, 'bin', 'explainroo.js'), ...args],
      { cwd }
    );
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout, stderr: err.stderr, error: err };
  }
}

/**
 * Generate a complete Explainroo video project from a topic using LLM.
 */
export async function generateVideo({
  topic,
  size = 'youtube',
  theme = 'midnight',
  voice = 'am_michael',
  autoRender = false,
  isDraft = false,
  slug: customSlug = null,
  onProgress = () => {},
}) {
  const rootDir = process.cwd();
  const slug = customSlug || slugify(topic) || `video-${Date.now()}`;
  const projectDir = path.join(rootDir, 'videos', slug);

  onProgress({ stage: 'llm_generating', message: `Generating script and scenes for "${topic}" via LLM...` });

  const userPrompt = buildUserPrompt({ topic, size, theme, voice });
  const generated = await callLLM({
    systemPrompt: EXPLAINROO_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.7,
    jsonMode: true,
  });

  if (!generated.script || !generated.scenes) {
    throw new Error('LLM failed to return both script and scenes in JSON output.');
  }

  // Ensure target folder exists
  fs.mkdirSync(projectDir, { recursive: true });

  const videoConfig = {
    title: generated.title || topic,
    theme: generated.theme || theme,
    size: size === 'shorts' ? '9:16' : '16:9',
    voice: generated.voice || voice,
    music: true,
    captions: 'auto',
    watermark: false,
  };

  const sanitized = sanitizeScriptAndScenes(generated.script, generated.scenes);
  let currentScript = sanitized.script;
  let currentScenes = sanitized.scenes;

  fs.writeFileSync(path.join(projectDir, 'video.json'), JSON.stringify(videoConfig, null, 2), 'utf8');
  fs.writeFileSync(path.join(projectDir, 'script.md'), currentScript, 'utf8');
  fs.writeFileSync(path.join(projectDir, 'scenes.js'), currentScenes, 'utf8');

  onProgress({ stage: 'files_written', message: `Saved project files to videos/${slug}` });

  // Step 1: Synthesize voice with Kokoro
  onProgress({ stage: 'voice_generating', message: 'Synthesizing voice narration and speech check...' });
  let voiceRes = await runExplainrooCommand(['voice', `videos/${slug}`], rootDir);

  // Step 2: Check layout and timing
  onProgress({ stage: 'checking', message: 'Checking scene layout and timing...' });
  let checkRes = await runExplainrooCommand(['check', `videos/${slug}`], rootDir);

  // Multi-pass self-healing if voice or check detected errors
  let healAttempts = 0;
  const maxHealAttempts = 2;

  while ((!voiceRes.ok || !checkRes.ok) && healAttempts < maxHealAttempts) {
    healAttempts++;
    const issueDetails = [voiceRes.stderr, voiceRes.stdout, checkRes.stderr, checkRes.stdout]
      .filter(Boolean)
      .join('\n')
      .trim();

    onProgress({
      stage: 'auto_fixing',
      message: `Detected issue during validation (attempt ${healAttempts}/${maxHealAttempts}). Prompting LLM for fix...`,
    });

    const fixPrompt = `
The previous video files had the following validation errors from Explainroo:
${issueDetails}

Current script.md:
${currentScript}

Current scenes.js:
${currentScenes}

Please fix the errors in script.md and scenes.js.
CRITICAL RULES:
- Every scene in script.md MUST start with "## <id>" or "## <id> {hold=1.5}" with no spaces, dots, or colons in <id>.
- Every <id> in script.md MUST have a matching function in scenes.js.
- Return the updated JSON with keys: "script" and "scenes".
`;

    try {
      const fixed = await callLLM({
        systemPrompt: EXPLAINROO_SYSTEM_PROMPT,
        userPrompt: fixPrompt,
        temperature: 0.2,
        jsonMode: true,
      });

      if (fixed.script || fixed.scenes) {
        const reSanitized = sanitizeScriptAndScenes(
          fixed.script || currentScript,
          fixed.scenes || currentScenes
        );
        currentScript = reSanitized.script;
        currentScenes = reSanitized.scenes;

        fs.writeFileSync(path.join(projectDir, 'script.md'), currentScript, 'utf8');
        fs.writeFileSync(path.join(projectDir, 'scenes.js'), currentScenes, 'utf8');

        voiceRes = await runExplainrooCommand(['voice', `videos/${slug}`], rootDir);
        checkRes = await runExplainrooCommand(['check', `videos/${slug}`], rootDir);
      }
    } catch (fixErr) {
      console.warn(`[Generator] Self-healing attempt ${healAttempts} failed:`, fixErr.message);
    }
  }

  // Step 3: Render MP4
  let renderRes = null;
  if (autoRender) {
    onProgress({ stage: 'rendering', message: `Rendering ${isDraft ? 'draft' : 'final'} video with ffmpeg...` });
    const renderArgs = ['render', `videos/${slug}`];
    if (isDraft) renderArgs.push('--draft');
    renderRes = await runExplainrooCommand(renderArgs, rootDir);

    // If render failed, attempt one self-healing pass before failing
    if (!renderRes.ok) {
      const renderError = renderRes.stderr || renderRes.stdout;
      onProgress({
        stage: 'auto_fixing',
        message: 'Render reported an error. Prompting LLM for repair...',
      });
      try {
        const renderFixPrompt = `
Explainroo render failed with:
${renderError}

Current script.md:
${currentScript}

Current scenes.js:
${currentScenes}

Please repair scenes.js and script.md to fix this error. Return JSON with "script" and "scenes".
`;
        const fixed = await callLLM({
          systemPrompt: EXPLAINROO_SYSTEM_PROMPT,
          userPrompt: renderFixPrompt,
          temperature: 0.2,
          jsonMode: true,
        });

        if (fixed.script || fixed.scenes) {
          const reSanitized = sanitizeScriptAndScenes(
            fixed.script || currentScript,
            fixed.scenes || currentScenes
          );
          fs.writeFileSync(path.join(projectDir, 'script.md'), reSanitized.script, 'utf8');
          fs.writeFileSync(path.join(projectDir, 'scenes.js'), reSanitized.scenes, 'utf8');
          await runExplainrooCommand(['voice', `videos/${slug}`], rootDir);
          renderRes = await runExplainrooCommand(renderArgs, rootDir);
        }
      } catch (rErr) {
        console.warn('[Generator] Render fix attempt failed:', rErr.message);
      }
    }

    if (!renderRes.ok) {
      throw new Error(`Explainroo render failed:\n${renderRes.stderr || renderRes.stdout}`);
    }
  }

  const outDir = path.join(projectDir, 'out');
  const mp4Path = path.join(outDir, isDraft ? 'draft.mp4' : 'video.mp4');
  const coverPath = path.join(outDir, isDraft ? 'draft.cover.jpg' : 'video.cover.jpg');
  const srtPath = path.join(outDir, isDraft ? 'draft.srt' : 'video.srt');

  return {
    slug,
    projectDir,
    title: videoConfig.title,
    checkPassed: checkRes.ok,
    checkOutput: checkRes.stdout,
    rendered: Boolean(renderRes?.ok && fs.existsSync(mp4Path)),
    files: {
      videoJson: path.join(projectDir, 'video.json'),
      scriptMd: path.join(projectDir, 'script.md'),
      scenesJs: path.join(projectDir, 'scenes.js'),
      mp4: fs.existsSync(mp4Path) ? mp4Path : null,
      cover: fs.existsSync(coverPath) ? coverPath : null,
      srt: fs.existsSync(srtPath) ? srtPath : null,
    },
  };
}
