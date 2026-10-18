#!/usr/bin/env node

/**
 * YouTube Video Uploader Script
 * Uploads video.mp4, sets custom thumbnail (video.cover.jpg),
 * and uploads captions (video.srt).
 *
 * Setup:
 *   1. Download your client_secret.json from Google Cloud Console.
 *   2. Save it as `client_secret.json` in the root folder.
 *   3. Run: node scripts/upload-youtube.js videos/git-internals
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const ROOT_DIR = process.cwd();
const CLIENT_SECRET_FILE = path.join(ROOT_DIR, 'client_secret.json');
const TOKEN_FILE = path.join(ROOT_DIR, 'youtube_token.json');

function findFile(filenames) {
  for (const name of filenames) {
    const p = path.join(ROOT_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function getOAuth2Client() {
  const secretFile = findFile(['client_secret.json', 'client_secrets.json']);
  const tokenFile = findFile(['youtube_token.json', 'token.json']);

  if (!secretFile) {
    throw new Error(
      `Missing client_secret.json!\nPlease download it from Google Cloud Console and place it at:\n${path.join(ROOT_DIR, 'client_secret.json')}`
    );
  }

  const content = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
  const keys = content.installed || content.web;
  if (!keys) throw new Error('Invalid client_secret.json format (expected "installed" or "web").');

  const redirectUri = keys.redirect_uris?.[0] || 'http://localhost:3001/oauth2callback';
  const oauth2Client = new google.auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);

  // Check if we already have saved tokens
  if (tokenFile) {
    const tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    // Support Python Google Auth token format
    if (tokens.token && !tokens.access_token) {
      tokens.access_token = tokens.token;
    }
    oauth2Client.setCredentials(tokens);
    return oauth2Client;
  }

  // Authorize via local web server
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    console.log(`\n======================================================`);
    console.log(`🔐 YouTube Authorization Required (First time only)`);
    console.log(`Open this link in your browser to authorize your YouTube channel:`);
    console.log(`\n${authUrl}\n`);
    console.log(`Waiting for authorization on http://localhost:3001/oauth2callback ...`);
    console.log(`======================================================\n`);

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost:3001');
        if (url.pathname === '/oauth2callback') {
          const code = url.searchParams.get('code');
          if (!code) throw new Error('Authorization code not found in callback URL.');

          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Authorization Successful!</h1><p>You can close this tab and return to your terminal.</p>');

          server.close();
          console.log(`✅ Authorization tokens saved to youtube_token.json`);
          resolve(oauth2Client);
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Authorization failed: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(3001);
  });
}

async function uploadVideo(projectPath, options = {}) {
  const absProjectDir = path.resolve(ROOT_DIR, projectPath);
  const videoJsonPath = path.join(absProjectDir, 'video.json');
  const outDir = path.join(absProjectDir, 'out');
  const mp4Path = path.join(outDir, 'video.mp4');
  const coverPath = path.join(outDir, 'video.cover.jpg');
  const srtPath = path.join(outDir, 'video.srt');
  const chaptersPath = path.join(outDir, 'video.chapters.txt');

  if (!fs.existsSync(mp4Path)) {
    throw new Error(`Video file not found at: ${mp4Path}\nMake sure to run "explainroo render" first!`);
  }

  const videoConfig = fs.existsSync(videoJsonPath)
    ? JSON.parse(fs.readFileSync(videoJsonPath, 'utf8'))
    : { title: path.basename(projectPath) };

  const title = options.title || videoConfig.title;
  let description = options.description || `${title}\n\nExplainer video created with Explainroo.\n`;

  if (fs.existsSync(chaptersPath)) {
    const chaptersText = fs.readFileSync(chaptersPath, 'utf8');
    description += `\nChapters:\n${chaptersText}\n`;
  }

  const tags = options.tags || ['explainer', 'coding', 'software development', 'programming'];
  const privacyStatus = options.privacy || 'private'; // 'private', 'unlisted', or 'public'

  console.log(`\nConnecting to YouTube API...`);
  const auth = await getOAuth2Client();
  const youtube = google.youtube({ version: 'v3', auth });

  console.log(`\nUploading video: "${title}" (${(fs.statSync(mp4Path).size / (1024 * 1024)).toFixed(1)} MB)...`);

  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: '28', // Science & Technology
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(mp4Path),
    },
  });

  const videoId = res.data.id;
  const videoUrl = `https://youtu.be/${videoId}`;
  console.log(`\n🎉 Video uploaded successfully!`);
  console.log(`🔗 Video URL: ${videoUrl}`);
  console.log(`🔒 Privacy: ${privacyStatus}`);

  // Upload custom thumbnail
  if (fs.existsSync(coverPath)) {
    try {
      console.log(`Uploading custom thumbnail...`);
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: 'image/jpeg',
          body: fs.createReadStream(coverPath),
        },
      });
      console.log(`✅ Thumbnail uploaded.`);
    } catch (thumbErr) {
      console.warn(`⚠️ Thumbnail upload note:`, thumbErr.message);
    }
  }

  // Upload subtitles / captions
  if (fs.existsSync(srtPath)) {
    try {
      console.log(`Uploading English captions (.srt)...`);
      await youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId,
            language: 'en',
            name: 'English',
            isDraft: false,
          },
        },
        media: {
          mimeType: '*/*',
          body: fs.createReadStream(srtPath),
        },
      });
      console.log(`✅ Captions uploaded.`);
    } catch (captionErr) {
      console.warn(`⚠️ Captions upload note:`, captionErr.message);
    }
  }

  return { videoId, videoUrl };
}

async function main() {
  const args = process.argv.slice(2);
  const projectPath = args[0] || 'videos/git-internals';
  const privacy = args.includes('--public') ? 'public' : args.includes('--unlisted') ? 'unlisted' : 'private';

  try {
    await uploadVideo(projectPath, { privacy });
  } catch (err) {
    console.error(`\n❌ Upload error:`, err.message);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('upload-youtube.js')) {
  main();
}

export { uploadVideo };
