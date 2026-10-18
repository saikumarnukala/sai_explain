#!/usr/bin/env node

/**
 * Lightweight REST API Server for Daily Script & Scene Generation
 * Uses native Node http module (zero npm dependencies).
 *
 * Endpoints:
 *   GET  /health          - Server health and LLM provider configuration
 *   GET  /api/topics      - List topics queue
 *   POST /api/topics      - Add topic to queue
 *   POST /api/generate    - Generate script & scenes (and optional render)
 *   GET  /api/videos      - List generated videos
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { generateVideo } from './generator.js';

try {
  if (process.loadEnvFile) process.loadEnvFile();
} catch (_) {}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON in request body.'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // 1. Health check
    if (req.method === 'GET' && pathname === '/health') {
      const hasGemini = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
      const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
      const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
      const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);

      return sendJson(res, 200, {
        status: 'ok',
        version: '1.0.0',
        activeProvider: hasGemini
          ? 'Google Gemini (gemini-2.5-flash)'
          : hasOpenRouter
          ? 'OpenRouter'
          : hasOpenAI
          ? 'OpenAI'
          : hasAnthropic
          ? 'Anthropic Claude'
          : 'None (Please set GEMINI_API_KEY in .env)',
        hasValidKey: hasGemini || hasOpenAI || hasAnthropic || hasOpenRouter,
      });
    }

    // 2. Topics list
    if (req.method === 'GET' && pathname === '/api/topics') {
      const topicsPath = path.join(process.cwd(), 'topics.json');
      const topics = fs.existsSync(topicsPath) ? JSON.parse(fs.readFileSync(topicsPath, 'utf8')) : [];
      return sendJson(res, 200, { topics });
    }

    // 3. Add topic
    if (req.method === 'POST' && pathname === '/api/topics') {
      const body = await parseBody(req);
      if (!body.topic) return sendJson(res, 400, { error: 'Missing "topic" in body.' });

      const topicsPath = path.join(process.cwd(), 'topics.json');
      const topics = fs.existsSync(topicsPath) ? JSON.parse(fs.readFileSync(topicsPath, 'utf8')) : [];
      const newTopic = {
        id: (topics[topics.length - 1]?.id || 0) + 1,
        topic: body.topic,
        theme: body.theme || 'midnight',
        size: body.size || 'youtube',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      topics.push(newTopic);
      fs.writeFileSync(topicsPath, JSON.stringify(topics, null, 2), 'utf8');

      return sendJson(res, 201, { message: 'Topic added', topic: newTopic });
    }

    // 4. Generate video
    if (req.method === 'POST' && pathname === '/api/generate') {
      const body = await parseBody(req);
      if (!body.topic) {
        return sendJson(res, 400, { error: 'Missing "topic" string in request body.' });
      }

      const result = await generateVideo({
        topic: body.topic,
        size: body.size || 'youtube',
        theme: body.theme || 'midnight',
        voice: body.voice || 'am_michael',
        autoRender: Boolean(body.render),
        isDraft: Boolean(body.draft),
      });

      return sendJson(res, 200, {
        success: true,
        result,
      });
    }

    // 5. List videos
    if (req.method === 'GET' && pathname === '/api/videos') {
      const videosDir = path.join(process.cwd(), 'videos');
      if (!fs.existsSync(videosDir)) return sendJson(res, 200, { videos: [] });

      const entries = fs.readdirSync(videosDir, { withFileTypes: true });
      const videos = entries
        .filter((d) => d.isDirectory())
        .map((d) => {
          const vDir = path.join(videosDir, d.name);
          const hasVideoJson = fs.existsSync(path.join(vDir, 'video.json'));
          const hasMp4 = fs.existsSync(path.join(vDir, 'out', 'video.mp4'));
          const hasDraft = fs.existsSync(path.join(vDir, 'out', 'draft.mp4'));
          return {
            slug: d.name,
            hasConfig: hasVideoJson,
            rendered: hasMp4,
            hasDraft,
            mp4Path: hasMp4 ? path.join(vDir, 'out', 'video.mp4') : null,
          };
        });

      return sendJson(res, 200, { videos });
    }

    // 404
    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🎬 Explainroo Video Generation API Server`);
  console.log(`🌐 Running at http://${HOST}:${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /api/topics`);
  console.log(`   POST /api/topics`);
  console.log(`   POST /api/generate`);
  console.log(`   GET  /api/videos`);
  console.log(`======================================================\n`);
});
