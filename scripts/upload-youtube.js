#!/usr/bin/env node

/**
 * Robust YouTube Resumable Video Uploader
 * Uploads video.mp4, sets custom thumbnail (video.cover.jpg),
 * and uploads captions (video.srt).
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const ROOT_DIR = process.cwd();

function findFile(filenames) {
  for (const name of filenames) {
    const p = path.join(ROOT_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getClientKeys() {
  if (process.env.CLIENT_SECRET_JSON) {
    try {
      const parsed = JSON.parse(process.env.CLIENT_SECRET_JSON);
      return parsed.installed || parsed.web || parsed;
    } catch (_) {}
  }

  const secretFile = findFile(['client_secret.json', 'client_secrets.json']);
  if (!secretFile) {
    throw new Error('Missing client_secret.json! Please place it in the project root or set CLIENT_SECRET_JSON.');
  }

  const content = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
  return content.installed || content.web || content;
}

function getStoredTokens() {
  if (process.env.YOUTUBE_TOKEN_JSON) {
    try {
      const parsed = JSON.parse(process.env.YOUTUBE_TOKEN_JSON);
      return parsed;
    } catch (_) {}
  }

  const tokenFile = findFile(['youtube_token.json', 'token.json']);
  if (!tokenFile) return null;

  return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
}

async function getAuthenticatedClient() {
  const keys = getClientKeys();
  const redirectUri = keys.redirect_uris?.[0] || 'http://localhost:3001/oauth2callback';
  const oauth2Client = new google.auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);

  let tokens = getStoredTokens();

  if (tokens) {
    const refreshToken = tokens.refresh_token;
    oauth2Client.setCredentials({
      refresh_token: refreshToken,
      access_token: tokens.token || tokens.access_token,
    });

    try {
      console.log('Refreshing YouTube access token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Save refreshed tokens locally if not in CI
      const tokenFile = findFile(['youtube_token.json', 'token.json']) || path.join(ROOT_DIR, 'youtube_token.json');
      fs.writeFileSync(tokenFile, JSON.stringify({ ...tokens, ...credentials }, null, 2), 'utf8');

      return { oauth2Client, accessToken: credentials.access_token };
    } catch (err) {
      console.warn('Could not refresh token automatically:', err.message);
    }
  }

  // Interactive browser authorization if no valid token
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

          const { tokens: newTokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(newTokens);

          const savePath = path.join(ROOT_DIR, 'youtube_token.json');
          fs.writeFileSync(savePath, JSON.stringify(newTokens, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Authorization Successful!</h1><p>You can close this tab and return to your terminal.</p>');

          server.close();
          console.log(`✅ Authorization tokens saved to youtube_token.json`);
          resolve({ oauth2Client, accessToken: newTokens.access_token });
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

function getLatestProject() {
  const videosDir = path.join(ROOT_DIR, 'videos');
  if (!fs.existsSync(videosDir)) return null;
  const entries = fs.readdirSync(videosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = path.join(videosDir, d.name);
      return { dir: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.dir || null;
}

export async function uploadVideo(projectPath, options = {}) {
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

  const tags = options.tags || ['explainer', 'coding', 'software development', 'programming', 'tech'];
  const privacyStatus = options.privacy || 'public';

  const { accessToken } = await getAuthenticatedClient();

  const fileStats = fs.statSync(mp4Path);
  const fileSize = fileStats.size;

  console.log(`\n======================================================`);
  console.log(`🎬 Initiating Resumable YouTube Upload`);
  console.log(`📌 Title: "${title}"`);
  console.log(`📦 File Size: ${(fileSize / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`🔒 Privacy: ${privacyStatus.toUpperCase()}`);
  console.log(`======================================================\n`);

  const metadata = {
    snippet: {
      title,
      description,
      tags,
      categoryId: '28', // Science & Technology
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  // Step 1: Initiate resumable session
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`Failed to initiate YouTube upload (${initRes.status}): ${errText}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not return a resumable upload location URL.');

  // Step 2: Upload binary video data via https.request (rock-solid on all OSes)
  console.log('Uploading video bytes to YouTube...');
  const fileBuffer = fs.readFileSync(mp4Path);
  const urlObj = new URL(uploadUrl);

  const videoData = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'PUT',
        headers: {
          'Content-Length': fileBuffer.length,
          'Content-Type': 'video/mp4',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              resolve({ id: null, raw });
            }
          } else {
            reject(new Error(`YouTube upload returned status ${res.statusCode}: ${raw}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
  const videoId = videoData.id;
  const videoUrl = `https://youtu.be/${videoId}`;

  console.log(`\n🎉 Upload Complete!`);
  console.log(`🔗 YouTube URL: ${videoUrl}`);
  console.log(`🆔 Video ID:    ${videoId}`);

  // Step 3: Upload custom thumbnail if available
  if (fs.existsSync(coverPath)) {
    try {
      console.log('\nUploading custom thumbnail...');
      const thumbStats = fs.statSync(coverPath);
      const thumbStream = fs.createReadStream(coverPath);
      const thumbRes = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'image/jpeg',
            'Content-Length': String(thumbStats.size),
          },
          body: thumbStream,
          duplex: 'half',
        }
      );
      if (thumbRes.ok) {
        console.log('✅ Custom thumbnail uploaded successfully.');
      } else {
        const thumbErr = await thumbRes.text();
        console.warn('⚠️ Custom thumbnail note:', thumbErr);
      }
    } catch (e) {
      console.warn('⚠️ Thumbnail note:', e.message);
    }
  }

  // Step 4: Upload subtitles / captions if available
  if (fs.existsSync(srtPath)) {
    try {
      console.log('Uploading closed captions (.srt)...');
      const captionMeta = {
        snippet: {
          videoId,
          language: 'en',
          name: 'English',
          isDraft: false,
        },
      };

      const srtStats = fs.statSync(srtPath);
      const capInitRes = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/captions?uploadType=resumable&part=snippet',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': '*/*',
            'X-Upload-Content-Length': String(srtStats.size),
          },
          body: JSON.stringify(captionMeta),
        }
      );

      if (capInitRes.ok) {
        const capUploadUrl = capInitRes.headers.get('location');
        if (capUploadUrl) {
          const srtStream = fs.createReadStream(srtPath);
          await fetch(capUploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Length': String(srtStats.size),
              'Content-Type': '*/*',
            },
            body: srtStream,
            duplex: 'half',
          });
          console.log('✅ Captions uploaded successfully.');
        }
      }
    } catch (e) {
      console.warn('⚠️ Captions note:', e.message);
    }
  }

  return { videoId, videoUrl };
}

async function main() {
  const args = process.argv.slice(2);
  let projectPath = null;
  let privacy = 'public';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--public') {
      privacy = 'public';
    } else if (arg === '--unlisted') {
      privacy = 'unlisted';
    } else if (arg === '--private') {
      privacy = 'private';
    } else if (arg === '--latest') {
      projectPath = getLatestProject();
    } else if (!arg.startsWith('--')) {
      projectPath = arg;
    }
  }

  if (!projectPath) {
    projectPath = getLatestProject() || 'videos/git-internals';
  }

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
