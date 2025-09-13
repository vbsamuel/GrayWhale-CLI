#!/usr/bin/env node
// Node.js v18+ has global fetch
// Usage:
//   node graywhale_cli.mjs /create [--write-project-vars|-w]
//   node graywhale_cli.mjs /list
//   node graywhale_cli.mjs /get <project_name>
//   node graywhale_cli.mjs /delete <project_name>
//   node graywhale_cli.mjs /token <project_name>

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output, argv } from 'node:process';

const {
    BASE_URL = 'https://app.productgenius.io',
    ACCESS_TOKEN,
    BASIC_USER,
    BASIC_PASS,
} = process.env;

// --- args parser ---
function parseArgs(argv) {
    const [, , cmd, ...rest] = argv;
    const flags = new Set(rest.filter((a) => a.startsWith('-')));
    const args = rest.filter((a) => !a.startsWith('-'));
    return { cmd, flags, args };
}

// Auth helper with modes - supports both credentials via auxiliary headers
function buildAuthHeader(preferred = 'auto') {
    // preferred: 'bearer' | 'basic' | 'auto'
    const hasBearer = !!process.env.ACCESS_TOKEN;
    const hasBasic = !!process.env.BASIC_USER && !!process.env.BASIC_PASS;

    let mode = 'none';
    const headers = {};

    // Choose primary Authorization header
    if (preferred === 'bearer' || (preferred === 'auto' && hasBearer)) {
        if (hasBearer) {
            headers.Authorization = `Bearer ${process.env.ACCESS_TOKEN}`;
            mode = 'bearer';
        }
    }
    if (mode === 'none' && (preferred === 'basic' || preferred === 'auto')) {
        if (hasBasic) {
            const b64 = Buffer.from(`${process.env.BASIC_USER}:${process.env.BASIC_PASS}`).toString('base64');
            headers.Authorization = `Basic ${b64}`;
            mode = 'basic';
        }
    }

    // Always include the "other" credential (if present) via auxiliary headers
    if (hasBasic) {
        const b64 = Buffer.from(`${process.env.BASIC_USER}:${process.env.BASIC_PASS}`).toString('base64');
        headers['X-Basic-Auth'] = `Basic ${b64}`;
    }
    if (hasBearer) {
        headers['X-Bearer-Token'] = process.env.ACCESS_TOKEN;
    }

    return { mode, headers };
}

// API helper with optional preferredAuth, includes auxiliary auth headers, and retries with fallback on 401/403
async function api(pathname, { method = 'GET', body, preferredAuth = 'auto' } = {}) {
    // First attempt with chosen primary auth; auxiliary headers will include the other credential if available
    let attempt = buildAuthHeader(preferredAuth);

    let res = await fetch(`${BASE_URL}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...attempt.headers },
        body: body ? JSON.stringify(body) : undefined,
    });

    // If unauthorized/forbidden, flip the primary Authorization and retry once
    if ((res.status === 401 || res.status === 403)) {
        const flippedPref = attempt.mode === 'bearer' ? 'basic' : 'bearer';
        const fallback = buildAuthHeader(flippedPref);
        if (fallback.mode !== 'none') {
            attempt = fallback;
            res = await fetch(`${BASE_URL}${pathname}`, {
                method,
                headers: { 'Content-Type': 'application/json', ...attempt.headers },
                body: body ? JSON.stringify(body) : undefined,
            });
        }
    }

    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }

    if (!res.ok) {
        console.error(`❌ ${res.status} ${res.statusText} for ${pathname} (auth=${attempt.mode})`);
        if (typeof json !== 'string') console.error(JSON.stringify(json, null, 2));
        else console.error(json);
        throw new Error(`Request failed ${res.status} ${res.statusText}`);
    }

    return json;
}

function banner(s) {
    console.log(`\n=== ${s} ===`);
}
function detectLineEnding(s) {
    return s.includes('\r\n') ? '\r\n' : '\n';
}
function backupOnce(filePath) {
    if (!fs.existsSync(filePath)) return;
    const bak = `${filePath}.bak`;
    try {
        if (!fs.existsSync(bak)) {
            fs.copyFileSync(filePath, bak);
            console.log(`📦 Backed up ${path.basename(filePath)} -> ${path.basename(bak)}`);
        }
    } catch (e) {
        console.warn('⚠️ Failed to backup .env:', e.message);
    }
}
function upsertEnvVar(filePath, key, value) {
    const exists = fs.existsSync(filePath);
    const safeVal = String(value).replace(/\r?\n/g, ' '); // keep .env single-line

    if (!exists) {
        fs.writeFileSync(filePath, `${key}=${safeVal}\n`, 'utf8');
        console.log(`📝 Created ${path.basename(filePath)} with ${key}=...`);
        return;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const EOL = detectLineEnding(raw);
    const lines = raw.split(/\r?\n/);
    const varRegex = new RegExp(`^\\s*${key}\\s*=`, 'i');

    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*#/.test(line)) continue; // skip commented lines
        if (varRegex.test(line)) {
            lines[i] = `${key}=${safeVal}`;
            replaced = true;
            break;
        }
    }
    if (!replaced) {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`${key}=${safeVal}`);
    }
    backupOnce(filePath);
    fs.writeFileSync(filePath, lines.join(EOL) + EOL, 'utf8');
    console.log(`✅ Updated ${key} in ${path.basename(filePath)}`);
}

// --- Prompt helpers ---
async function promptRequired(rl, label, description, validator) {
    while (true) {
        console.log(`\n${label}:\n  ${description}`);
        const val = (await rl.question(`${label}: `)).trim();
        if (!val) {
            const again = (await rl.question("(empty) Press [Enter] to re-try or type 'q' to quit: ")).trim().toLowerCase();
            if (again === 'q') throw new Error('USER_ABORT');
            continue;
        }
        if (validator) {
            const err = validator(val);
            if (err) {
                console.log(`❌ ${err}`);
                continue;
            }
        }
        return val;
    }
}
const emailValidator = (s) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? null : 'Invalid email format.';

/** Multiline summary using an EOF sentinel line */
async function promptMultilineSummary(rl) {
    console.log(`
project_summary:
  Paste or type your description below (multi-line is OK).
  When finished, type a single line containing: EOF
`);
    const lines = [];
    while (true) {
        const line = await rl.question('');
        if (line.trim() === 'EOF') break;
        lines.push(line);
    }
    const text = lines.join('\n').trim();
    if (!text) throw new Error('EMPTY_SUMMARY');
    return text;
}

// /create
async function cmdCreate(flags) {
    const rl = readline.createInterface({ input, output });

    banner('Provide required fields for /hackathon/project/create');

    const PROJECT_NAME = await promptRequired(
        rl,
        'project_name',
        'A unique name for the project. Used as the identifier for all subsequent interactions.'
    );

    let PROJECT_SUMMARY;
    while (true) {
        try {
            PROJECT_SUMMARY = await promptMultilineSummary(rl);
            break;
        } catch (e) {
            if (e.message === 'EMPTY_SUMMARY') {
                const again = (await rl
                    .question("Summary is empty. Press [Enter] to re-try or type 'q' to quit: "))
                    .trim()
                    .toLowerCase();
                if (again === 'q') throw new Error('USER_ABORT');
                continue;
            }
            throw e;
        }
    }

    const HACKER_EMAIL = await promptRequired(
        rl,
        'hacker_email',
        'Email where notifications will be sent once your model is ready.',
        emailValidator
    );

    const FIRST_NAME = await promptRequired(rl, 'first_name', 'First name of the hacker.');
    const LAST_NAME = await promptRequired(rl, 'last_name', 'Last name of the hacker.');

    await rl.close();

    banner('Creating project');
    const payload = {
        project_name: PROJECT_NAME,
        project_summary: PROJECT_SUMMARY,
        hacker_email: HACKER_EMAIL,
        first_name: FIRST_NAME ?? '',
        last_name: LAST_NAME ?? '',
    };

    let created;
    try {
        // Force Basic for creation
        created = await api('/hackathon/project/create', {
            method: 'POST',
            body: payload,
            preferredAuth: 'basic',
        });
    } catch (e) {
        console.error('\n❌ Project creation failed.');
        console.error(e.message);
        process.exit(1);
    }

    const accessToken = created?.access_token;

    banner('Project created');
    console.log('Project Name   :', PROJECT_NAME);
    console.log('Hacker Email   :', HACKER_EMAIL);
    console.log('First/Last     :', FIRST_NAME, LAST_NAME);
    console.log(
        'Summary preview:',
        (PROJECT_SUMMARY || '').slice(0, 160) + (PROJECT_SUMMARY.length > 160 ? '…' : '')
    );

    if (accessToken) {
        console.log('\n🔑 Access Token (save this):');
        console.log(accessToken);
    } else {
        console.log('\n⚠️ No access_token returned. Check server response and auth mode.');
        return;
    }

    // Write ACCESS_TOKEN and optional vars to .env
    try { upsertEnvVar('.env', 'BASE_URL', BASE_URL); } catch (e) { console.warn('⚠️ BASE_URL:', e.message); }
    try { upsertEnvVar('.env', 'ACCESS_TOKEN', accessToken); } catch (e) { console.warn('⚠️ ACCESS_TOKEN:', e.message); }
    try { upsertEnvVar('.env', 'PROJECT_NAME', PROJECT_NAME); } catch (e) { console.warn('⚠️ PROJECT_NAME:', e.message); }

    const writeProjectVars = flags.has('--write-project-vars') || flags.has('-w');
    if (writeProjectVars) {
        try { upsertEnvVar('.env', 'PROJECT_NAME', PROJECT_NAME); } catch { }
        try { upsertEnvVar('.env', 'PROJECT_SUMMARY', PROJECT_SUMMARY.replace(/\r?\n/g, ' ')); } catch { }
        try { upsertEnvVar('.env', 'HACKER_EMAIL', HACKER_EMAIL); } catch { }
        try { upsertEnvVar('.env', 'FIRST_NAME', FIRST_NAME); } catch { }
        try { upsertEnvVar('.env', 'LAST_NAME', LAST_NAME); } catch { }
    }

    banner('What’s next');
    console.log(
        `Your .env is updated with ACCESS_TOKEN (and project vars if requested).

Run your tests:
  node hackathon_tester.mjs

Re-run with a new project anytime:
  node graywhale_cli.mjs /create --write-project-vars`
    );
}

// /lst
async function cmdList(flags) {
    banner('Listing projects');

    let projects;
    try {
        // Per spec, listing projects uses Basic auth
        projects = await api('/hackathon/project/list', {
            method: 'GET',
            preferredAuth: 'basic',
        });
    } catch (e) {
        console.error('\n❌ Failed to list projects.');
        console.error(e.message);
        process.exit(1);
    }

    if (!Array.isArray(projects) || projects.length === 0) {
        console.log('\n(no projects found)');
        return;
    }

    projects.forEach((p, i) => {
        const name = p.project_name ?? '(unnamed)';
        const email = p.hacker_email ?? '(none)';
        const created = p.created_at ?? '(no timestamp)';
        const sum = (p.project_summary ?? '');
        const preview = sum.length > 120 ? sum.slice(0, 120) + '…' : sum;

        console.log(`\n#${i + 1}`);
        console.log(`  Name    : ${name}`);
        console.log(`  Email   : ${email}`);
        console.log(`  Created : ${created}`);
        console.log(`  Summary : ${preview}`);
    });
}

async function cmdGet(projectName, flags) {
    if (!projectName) {
        console.error('Usage: node graywhale_cli.mjs /get <project_name>');
        process.exit(1);
    }
    banner(`Get project: ${projectName}`);
    let proj;
    try {
        proj = await api(`/hackathon/project/${encodeURIComponent(projectName)}`, {
            method: 'GET',
            preferredAuth: 'basic',
        });
    } catch (e) {
        console.error('\n❌ Failed to fetch project.');
        console.error(e.message);
        process.exit(1);
    }
    if (!proj) {
        console.log('(no project data returned)');
        return;
    }
    const sum = proj.project_summary || '';
    console.log(`\nName    : ${proj.project_name ?? projectName}`);
    console.log(`Email   : ${proj.hacker_email ?? '(none)'}`);
    console.log(`Created : ${proj.created_at ?? '(no timestamp)'}`);
    console.log(`Token   : ${proj.access_token ? '[available via /token email route]' : '(not shown)'}`);
    console.log(`Summary :\n${sum}`);
}

async function cmdDelete(projectName, flags) {
    if (!projectName) {
        console.error('Usage: node graywhale_cli.mjs /delete <project_name>');
        process.exit(1);
    }
    const rl = readline.createInterface({ input, output });
    banner(`Delete project: ${projectName}`);
    console.log('This action cannot be undone.');
    const confirm = (await rl.question(`Type the project name exactly to confirm deletion (or 'cancel' to abort): `)).trim();
    if (confirm.toLowerCase() === 'cancel') {
        console.log('🚫 Deletion cancelled.');
        await rl.close();
        return;
    }
    if (confirm !== projectName) {
        console.log('❌ Confirmation did not match project name. Aborting.');
        await rl.close();
        process.exit(1);
    }
    await rl.close();

    let resp;
    try {
        resp = await api(`/hackathon/project/${encodeURIComponent(projectName)}/delete`, {
            method: 'DELETE',
            preferredAuth: 'basic',
        });
    } catch (e) {
        console.error('\n❌ Failed to delete project.');
        console.error(e.message);
        process.exit(1);
    }
    console.log('✅ Project deleted:', projectName);
}

// /token
// /token
async function cmdToken(projectName, flags) {
    const rl = readline.createInterface({ input, output });

    // project_name: take from arg or prompt
    let proj = projectName;
    if (!proj) {
        proj = await promptRequired(
            rl,
            'project_name',
            'Name of the project whose access token you want to request via email.'
        );
    }

    await rl.close();

    banner(`Requesting access token for project: ${proj}`);

    try {
        // Spec: GET /hackathon/project/{project_name}/token (Basic auth)
        const resp = await api(`/hackathon/project/${encodeURIComponent(proj)}/token`, {
            method: 'GET',
            preferredAuth: 'basic',
        });

        // Most implementations return true or a message; be permissive in printing
        console.log('✅ Token request sent.');
        if (resp !== undefined && resp !== null && resp !== true) {
            console.log('Server response:', typeof resp === 'string' ? resp : JSON.stringify(resp));
        }
        console.log('📧 The access token will be emailed to the project owner (registered hacker_email).');
    } catch (e) {
        console.error('\n❌ Failed to request token.');
        console.error(e.message);
        process.exit(1);
    }
}

function printHelp() {
    console.log(
        `Usage:
  node graywhale_cli.mjs /create [--write-project-vars|-w]
  node graywhale_cli.mjs /list
  node graywhale_cli.mjs /get <project_name>
  node graywhale_cli.mjs /delete <project_name>
  node graywhale_cli.mjs /token <project_name>

Commands:
/create
  Prompts for:
    • project_name        – unique identifier for the project
    • project_summary     – multi-line text; finish by typing a line with "EOF"
    • hacker_email        – where notifications are sent
    • first_name
    • last_name
  Forces Basic auth for creation, prints and saves ACCESS_TOKEN to .env.
  With --write-project-vars (-w), also writes the other fields.

/list
  List all projects for your account (uses Basic auth).

/get <project_name>
  Fetch a single project's details (uses Basic auth).

/delete <project_name>
  Delete a project (uses Basic auth). Requires typing the project name to confirm.

/token <project_name>
  Request a new access token for a project (uses Basic auth).
  The server emails the token to the project's registered hacker_email; no email input is required.
  `
    );
}

async function main() {
    const { cmd, flags, args } = parseArgs(argv);
    if (!cmd || cmd === '--help' || cmd === '-h') return printHelp();

    if (cmd === '/create') {
        try { await cmdCreate(flags); }
        catch (e) {
            if (e.message === 'USER_ABORT') {
                console.log('\n👋 Aborted by user.');
                process.exit(0);
            }
            console.error('Fatal:', e);
            process.exit(1);
        }
        return;
    }

    if (cmd === '/lst' || cmd === '/list') {
        try { await cmdList(flags); }
        catch (e) {
            console.error('Fatal:', e);
            process.exit(1);
        }
        return;
    }

    if (cmd === '/get') {
        try { await cmdGet(args[0], flags); }
        catch (e) { console.error('Fatal:', e); process.exit(1); }
        return;
    }

    if (cmd === '/delete') {
        try { await cmdDelete(args[0], flags); }
        catch (e) { console.error('Fatal:', e); process.exit(1); }
        return;
    }

    if (cmd === '/token') {
        try { await cmdToken(args[0], flags); }
        catch (e) { console.error('Fatal:', e); process.exit(1); }
        return;
    }

    console.error('Unknown command:', cmd);
    printHelp();
    process.exit(1);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});