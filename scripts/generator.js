import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { callLLM } from './llm.js';
import { EXPLAINROO_SYSTEM_PROMPT, buildUserPrompt } from './system-prompt.js';

const execFileAsync = promisify(execFile);

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
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
  };

  fs.writeFileSync(path.join(projectDir, 'video.json'), JSON.stringify(videoConfig, null, 2), 'utf8');
  fs.writeFileSync(path.join(projectDir, 'script.md'), generated.script.trim() + '\n', 'utf8');
  fs.writeFileSync(path.join(projectDir, 'scenes.js'), generated.scenes.trim() + '\n', 'utf8');

  onProgress({ stage: 'files_written', message: `Saved project files to videos/${slug}` });

  // Step 1: Generate voice with Kokoro
  onProgress({ stage: 'voice_generating', message: 'Synthesizing voice narration and speech check...' });
  const voiceRes = await runExplainrooCommand(['voice', `videos/${slug}`], rootDir);
  if (!voiceRes.ok) {
    console.warn('Voice generation warning:', voiceRes.stderr || voiceRes.stdout);
  }

  // Step 2: Check layout and markers
  onProgress({ stage: 'checking', message: 'Checking scene layout and timing...' });
  let checkRes = await runExplainrooCommand(['check', `videos/${slug}`], rootDir);

  // If check reported errors, attempt one self-healing prompt
  if (!checkRes.ok && checkRes.stdout?.includes('error:')) {
    onProgress({ stage: 'auto_fixing', message: 'Detected issues in layout/scenes. Prompting LLM for fix...' });
    const fixPrompt = `
The previous scenes.js had the following errors when checked by Explainroo:
${checkRes.stdout}

Current script.md:
${generated.script}

Current scenes.js:
${generated.scenes}

Please fix the errors in scenes.js and return the updated JSON with keys: "script" and "scenes".
`;
    try {
      const fixed = await callLLM({
        systemPrompt: EXPLAINROO_SYSTEM_PROMPT,
        userPrompt: fixPrompt,
        temperature: 0.3,
        jsonMode: true,
      });

      if (fixed.scenes) {
        fs.writeFileSync(path.join(projectDir, 'scenes.js'), fixed.scenes.trim() + '\n', 'utf8');
        if (fixed.script) {
          fs.writeFileSync(path.join(projectDir, 'script.md'), fixed.script.trim() + '\n', 'utf8');
          await runExplainrooCommand(['voice', `videos/${slug}`], rootDir);
        }
        checkRes = await runExplainrooCommand(['check', `videos/${slug}`], rootDir);
      }
    } catch (fixErr) {
      console.warn('Auto-fix failed:', fixErr.message);
    }
  }

  let renderRes = null;
  if (autoRender) {
    onProgress({ stage: 'rendering', message: `Rendering ${isDraft ? 'draft' : 'final'} video with ffmpeg...` });
    const renderArgs = ['render', `videos/${slug}`];
    if (isDraft) renderArgs.push('--draft');
    renderRes = await runExplainrooCommand(renderArgs, rootDir);
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
