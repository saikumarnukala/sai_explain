#!/usr/bin/env node

/**
 * Daily Video Pipeline CLI
 * Usage:
 *   node scripts/daily-pipeline.js --topic "How Redis Works" --render
 *   node scripts/daily-pipeline.js --next --render
 *   node scripts/daily-pipeline.js --next --shorts --render
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateVideo } from './generator.js';

try {
  if (process.loadEnvFile) process.loadEnvFile();
} catch (_) {}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    topic: null,
    next: false,
    render: false,
    draft: false,
    shorts: false,
    theme: 'midnight',
    voice: 'am_michael',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--topic' || arg === '-t') {
      options.topic = args[++i];
    } else if (arg === '--next' || arg === '-n') {
      options.next = true;
    } else if (arg === '--render' || arg === '-r') {
      options.render = true;
    } else if (arg === '--draft' || arg === '-d') {
      options.draft = true;
      options.render = true;
    } else if (arg === '--shorts' || arg === '-s') {
      options.shorts = true;
    } else if (arg === '--theme') {
      options.theme = args[++i];
    } else if (arg === '--voice') {
      options.voice = args[++i];
    }
  }

  return options;
}

async function getNextTopic() {
  const topicsPath = path.join(process.cwd(), 'topics.json');
  if (!fs.existsSync(topicsPath)) {
    throw new Error('topics.json not found.');
  }

  const topics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  const nextItem = topics.find((t) => t.status === 'pending');
  if (!nextItem) {
    throw new Error('No pending topics left in topics.json! Add more topics or specify --topic.');
  }

  return { nextItem, topics, topicsPath };
}

async function markTopicDone(topicsPath, topics, itemId) {
  const item = topics.find((t) => t.id === itemId);
  if (item) {
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    fs.writeFileSync(topicsPath, JSON.stringify(topics, null, 2), 'utf8');
  }
}

async function main() {
  const opts = parseArgs();

  let selectedTopic = opts.topic;
  let topicContext = null;
  let theme = opts.theme;
  let size = opts.shorts ? 'shorts' : 'youtube';

  if (!selectedTopic && opts.next) {
    topicContext = await getNextTopic();
    selectedTopic = topicContext.nextItem.topic;
    theme = topicContext.nextItem.theme || theme;
    if (!opts.shorts && topicContext.nextItem.size) size = topicContext.nextItem.size;
    console.log(`[Queue] Picked next topic #${topicContext.nextItem.id}: "${selectedTopic}"`);
  }

  if (!selectedTopic) {
    console.log(`
Usage:
  node scripts/daily-pipeline.js --topic "Your Topic Here" [--render] [--shorts]
  node scripts/daily-pipeline.js --next [--render] [--shorts]

Options:
  --topic, -t <string>    The topic to explain
  --next, -n              Pick the next pending topic from topics.json
  --render, -r            Automatically render the MP4 video with ffmpeg
  --draft, -d             Render a faster, half-size draft MP4
  --shorts, -s            Format for YouTube Shorts / Reels (9:16 vertical)
  --theme <name>          Theme (midnight, paper, clean, chalk, blueprint)
  --voice <name>          Kokoro voice (am_michael, af_heart, etc.)
`);
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Daily Video Generation`);
  console.log(`📌 Topic: ${selectedTopic}`);
  console.log(`📐 Format: ${size.toUpperCase()}`);
  console.log(`🎨 Theme: ${theme}`);
  console.log(`======================================================\n`);

  try {
    const result = await generateVideo({
      topic: selectedTopic,
      size,
      theme,
      voice: opts.voice,
      autoRender: opts.render,
      isDraft: opts.draft,
      onProgress: ({ message }) => console.log(`[Progress] ${message}`),
    });

    console.log(`\n✅ Video project created successfully!`);
    console.log(`📁 Project folder: ${result.projectDir}`);
    console.log(`📄 Script: ${result.files.scriptMd}`);
    console.log(`🎨 Scenes: ${result.files.scenesJs}`);

    if (result.files.mp4) {
      console.log(`🎬 Rendered MP4: ${result.files.mp4}`);
      if (result.files.cover) console.log(`🖼️ Thumbnail: ${result.files.cover}`);
      if (result.files.srt) console.log(`📝 Subtitles: ${result.files.srt}`);
    } else {
      console.log(`\nTip: To render the final video, run:`);
      console.log(`  node bin/explainroo.js render videos/${result.slug}`);
    }

    if (topicContext) {
      await markTopicDone(topicContext.topicsPath, topicContext.topics, topicContext.nextItem.id);
      console.log(`[Queue] Marked topic #${topicContext.nextItem.id} as completed.`);
    }

    console.log(`\n🎉 All done!`);
  } catch (err) {
    console.error(`\n❌ Error generating video:`, err.message);
    process.exit(1);
  }
}

main();
