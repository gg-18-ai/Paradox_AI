require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
    console.warn("\n⚠️  WARNING: GROQ_API_KEY is not defined in the environment variables!");
    console.warn("Please create a .env file in the root directory of this project and add:");
    console.warn("GROQ_API_KEY=your_groq_api_key\n");
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.post('/api/chat', async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            res.status(500).json({
                error: {
                    message: "GROQ_API_KEY is not configured on the backend server. Please create a .env file and define GROQ_API_KEY."
                }
            });
            return;
        }
        const { model, messages } = req.body;
        
        let groqModel = 'llama-3.3-70b-versatile';
        if (model && model.includes('Opus')) {
            groqModel = 'llama-3.3-70b-versatile';
        } else if (model && model.includes('Haiku')) {
            groqModel = 'llama-3.1-8b-instant';
        }

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: groqModel,
                messages: messages,
                stream: true
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            let parsedErr;
            try {
                parsedErr = JSON.parse(errText);
            } catch (e) {
                parsedErr = { error: { message: errText } };
            }
            res.status(response.status).json(parsedErr);
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        for await (const chunk of response.body) {
            res.write(chunk);
        }
        res.end();

    } catch (error) {
        console.error("Error in proxy handler:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

const tempDir = path.join(__dirname, 'temp_code');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

const extMap = {
    'html': 'html',
    'htm': 'html',
    'javascript': 'js',
    'js': 'js',
    'typescript': 'ts',
    'ts': 'ts',
    'python': 'py',
    'py': 'py',
    'css': 'css',
    'json': 'json',
    'cpp': 'cpp',
    'c': 'c',
    'java': 'java',
    'rust': 'rs',
    'rs': 'rs',
    'go': 'go',
    'sql': 'sql',
    'bash': 'sh',
    'sh': 'sh',
    'markdown': 'md',
    'md': 'md'
};

app.post('/api/open-editor', (req, res) => {
    const { code, language } = req.body;
    if (!code) {
        return res.status(400).json({ error: "Code content is empty" });
    }

    const ext = extMap[String(language).toLowerCase()] || 'txt';
    const fileName = `code_${Date.now()}.${ext}`;
    const filePath = path.join(tempDir, fileName);

    fs.writeFile(filePath, code, (err) => {
        if (err) {
            console.error("Failed to write temp file:", err);
            return res.status(500).json({ error: "Failed to create temp file" });
        }

        exec(`code "${filePath}"`, (error) => {
            if (error) {
                console.log("VS Code command 'code' failed or not in PATH, trying default system editor...");
                exec(`powershell -Command Start-Process "${filePath}"`, (fallbackErr) => {
                    if (fallbackErr) {
                        console.error("Failed to open default editor:", fallbackErr);
                        return res.status(500).json({ error: "Failed to open in default system editor" });
                    }
                    return res.json({ success: true, openedWith: "default_editor", path: filePath });
                });
            } else {
                return res.json({ success: true, openedWith: "vscode", path: filePath });
            }
        });
    });
});

// --- BROWSER AUTOMATION BACKEND (REPLACED WITH BROWSER USE) ---

// Preserved endpoints to maintain frontend UI integration
app.get('/api/automation/auth-status', (req, res) => {
    try {
        const authMemoryPath = path.join(tempDir, 'auth_memory.json');
        let authMemory = {};
        if (fs.existsSync(authMemoryPath)) {
            authMemory = JSON.parse(fs.readFileSync(authMemoryPath, 'utf8'));
        }
        res.json(authMemory);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/automation/save-credentials', (req, res) => {
    const { domain, username, password } = req.body;
    if (!domain || !username || !password) {
        return res.status(400).json({ error: "domain, username, and password are required" });
    }
    try {
        const credPath = path.join(tempDir, 'credentials.json');
        let creds = {};
        if (fs.existsSync(credPath)) {
            creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        }
        creds[domain] = { username, password };
        fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), 'utf8');
        res.json({ success: true, message: `Credentials saved for domain ${domain}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/automation/open-external', (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: "URL is empty" });
    }
    exec(`start msedge "${url}"`, (error) => {
        if (error) {
            console.error("Failed to open URL in Edge:", error);
            return res.status(500).json({ error: "Failed to open Edge" });
        }
        res.json({ success: true });
    });
});

app.post('/api/automation/resume-action', async (req, res) => {
    res.json({ success: true, message: "Handled autonomously by Browser Use." });
});

// Primary task runner replacing the custom observe-think-act loop
app.post('/api/automation/run', async (req, res) => {
    const { command, headless } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial keepalive comment to open SSE stream immediately
    res.write(':\n\n');

    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        try {
            res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
        } catch (e) {
            console.error("[System] Failed to write event:", e);
        }
    };

    if (!command) {
        sendEvent('error', 'Command is empty');
        res.end();
        return;
    }

    if (!GROQ_API_KEY) {
        sendEvent('error', 'GROQ_API_KEY is not configured on the backend server. Please define GROQ_API_KEY.');
        res.end();
        return;
    }

    // Logging requirements: Task received, Browser Use started
    console.log(`\n[System] Task received: "${command}"`);
    console.log(`[System] Browser Use started`);
    sendEvent('log', `Task received: ${command}`);
    sendEvent('log', 'Browser Use started');

    const { spawn } = require('child_process');
    
    // Spawn python sidecar browser_use_agent.py
    const pythonArgs = ['browser_use_agent.py', '--task', command];
    if (headless !== false) {
        pythonArgs.push('--headless');
    }

    const env = { ...process.env, GROQ_API_KEY };
    // Spawn without shell: true to prevent Windows shell parsing of spaces
    const child = spawn('python', pythonArgs, { env, cwd: __dirname });
    let buffer = '';

    child.on('error', (err) => {
        console.error('[System] Subprocess spawn error:', err);
        sendEvent('log', `[Error] Failed to start Browser Use process: ${err.message}`);
        sendEvent('error', `Failed to start Browser Use: ${err.message}`);
    });

    child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // save the last incomplete chunk

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.event && parsed.data !== undefined) {
                    sendEvent(parsed.event, parsed.data);
                    
                    // Logging requirements: Browser Use action, Task completed, Error occurred
                    if (parsed.event === 'log') {
                        console.log(`[Browser Use Log] ${parsed.data}`);
                    } else if (parsed.event === 'complete') {
                        console.log(`[System] Task completed: ${parsed.data}`);
                    } else if (parsed.event === 'error') {
                        console.error(`[System] Error occurred: ${parsed.data}`);
                    }
                }
            } catch (err) {
                // Non-JSON logging
                sendEvent('log', trimmed);
                console.log(`[Python Output] ${trimmed}`);
            }
        }
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
            sendEvent('log', `[Python Stderr] ${msg}`);
            console.error(`[Python Stderr] ${msg}`);
        }
    });

    child.on('close', (code) => {
        console.log(`[System] Browser Use subprocess closed with exit code ${code}`);
        if (!res.writableEnded) {
            if (code !== 0) {
                // Logging requirements: Error occurred
                console.error(`[System] Error occurred: subprocess exited with non-zero code ${code}`);
                sendEvent('error', `Browser Use process exited with code ${code}`);
            }
            res.end();
        }
    });

    // Handle connection close on response object instead of request object
    res.on('close', () => {
        console.log('[System] Client disconnected (response closed), terminating Browser Use process...');
        child.kill();
    });
});

// Serve ggg.html as the index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ggg.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
