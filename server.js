require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { chromium } = require('playwright');
const crypto = require('crypto');


const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const activeSessions = new Map();

if (!GROQ_API_KEY) {
    console.warn("\n⚠️  WARNING: GROQ_API_KEY is not defined in the environment variables!");
    console.warn("Please create a .env file in the root directory of this project and add:");
    console.warn("GROQ_API_KEY=your_groq_api_key\n");
}

const fetchWithRetry = async (url, options, retries = 3, delay = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            const errText = await response.text();
            console.warn(`[System] Fetch attempt ${i + 1} failed with status: ${response.status}. Details: ${errText}`);
            
            // Fast fail on 4xx client errors (e.g. Model Decommissioned, Invalid Request) to avoid lag, except 429 (Rate Limit)
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                throw new Error(`HTTP ${response.status}: ${errText}`);
            }
        } catch (err) {
            console.error(`[System] Fetch attempt ${i + 1} encountered error: ${err.message}`);
            if (err.message.startsWith('HTTP ') || i === retries - 1) throw err;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new Error(`Fetch failed after ${retries} attempts.`);
};

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
        
        // Map user model selection to actual Groq models on the secure backend
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

        // Try to open in VS Code first
        exec(`code "${filePath}"`, (error) => {
            if (error) {
                console.log("VS Code command 'code' failed or not in PATH, trying default system editor...");
                
                // Fallback: start file in default system editor
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

// --- BROWSER AUTOMATION BACKEND ---
function generateMockData(fieldTitle) {
    const lower = fieldTitle.toLowerCase();
    if (lower.includes('name')) return 'John Doe';
    if (lower.includes('email') || lower.includes('mail')) return 'johndoe@example.com';
    if (lower.includes('phone') || lower.includes('mobile') || lower.includes('contact')) return '9876543210';
    if (lower.includes('age')) return '25';
    if (lower.includes('gender')) return 'Male';
    if (lower.includes('address')) return '123 Main Street, New York, NY 10001';
    if (lower.includes('city')) return 'New York';
    if (lower.includes('country')) return 'United States';
    if (lower.includes('feedback') || lower.includes('comment') || lower.includes('opinion')) return 'This is a automatically generated response. The automation is working flawlessly! Very impressed.';
    if (lower.includes('date')) return new Date().toISOString().split('T')[0];
    if (lower.includes('website') || lower.includes('url')) return 'https://example.com';
    return 'Mock Response';
}

const getLLMResponse = async (fieldTitle) => {
    if (!GROQ_API_KEY) {
        return generateMockData(fieldTitle);
    }
    try {
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an automated browser form filler. You fill fields with realistic mock data or helpful inputs. Provide ONLY the value to input into the field, with no surrounding quotes, explanations, or labels.'
                    },
                    {
                        role: 'user',
                        content: `Field name/question: "${fieldTitle}". Generate a suitable, short, realistic response.`
                    }
                ],
                temperature: 0.7,
                max_tokens: 50
            })
        });
        const data = await response.json();
        return data.choices[0].message.content.trim();
    } catch (err) {
        console.error("LLM field generation error:", err);
    }
    return generateMockData(fieldTitle);
};

// --- AUTOMATION PLAN GENERATOR ---
const getAutomationPlan = async (command) => {
    const searchMatch = command.match(/open\s+(\w+)\s+(?:and\s+)?search\s+(?:me\s+)?(?:a\s+)?(?:for\s+)?(.+)/i);
    if (searchMatch) {
        const website = searchMatch[1].toLowerCase();
        const query = searchMatch[2].trim();
        
        let startUrl = '';
        let inputSelector = 'input[type="text"]';
        
        if (website.includes('flipkart')) {
            startUrl = 'https://www.flipkart.com';
            inputSelector = 'input[title*="Search" i], input[placeholder*="Search" i], input[type="text"]';
        } else if (website.includes('amazon')) {
            startUrl = 'https://www.amazon.in';
            inputSelector = 'input[placeholder*="Search" i], input[id="twotabsearchtextbox"]';
        } else if (website.includes('google')) {
            startUrl = 'https://www.google.com';
            inputSelector = 'textarea[name="q"], input[name="q"]';
        }
        
        if (startUrl) {
            return {
                url: startUrl,
                actions: [
                    { type: 'type', selector: inputSelector, value: query, description: `Type "${query}" into search bar` },
                    { type: 'pressKey', key: 'Enter', description: 'Submit search query' }
                ]
            };
        }
    }
    
    if (/^https?:\/\//i.test(command.trim())) {
        return {
            url: command.trim(),
            actions: [{ type: 'fillForm', description: 'Analyze and auto-fill page forms' }]
        };
    }

    if (GROQ_API_KEY) {
        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        {
                            role: 'system',
                            content: `You are a web automation planner. The user wants to run an automated browser task.
Translate the user's natural language command into a structured JSON execution plan.
JSON Structure:
{
  "url": "Start URL to navigate to",
  "actions": [
    {
      "type": "type" | "click" | "pressKey" | "fillForm",
      "selector": "CSS selector to target, if needed",
      "value": "Value to type, if needed",
      "key": "Key to press (e.g. 'Enter'), if needed",
      "description": "Short description of this step"
    }
  ]
}
Examples:
- "open flipkart and search me a macbook air with m4"
  {"url": "https://www.flipkart.com", "actions": [{"type": "type", "selector": "input[title*='Search' i], input[placeholder*='Search' i]", "value": "macbook air with m4", "description": "Type query"}, {"type": "pressKey", "key": "Enter", "description": "Press Enter"}]}
- "https://docs.google.com/forms/..."
  {"url": "https://docs.google.com/forms/...", "actions": [{"type": "fillForm", "description": "Analyze and auto-fill form"}]}

Return ONLY the JSON. No explanations.`
                        },
                        {
                            role: 'user',
                            content: `Command: "${command}"`
                        }
                    ],
                    temperature: 0.2,
                    response_format: { type: "json_object" }
                })
            });
            if (response.ok) {
                const data = await response.json();
                return JSON.parse(data.choices[0].message.content.trim());
            }
        } catch (err) {
            console.error("LLM planning error:", err);
        }
    }

    return {
        url: `https://www.google.com/search?q=${encodeURIComponent(command)}`,
        actions: []
    };
};

// --- FORM AUTO-FILL LOGIC ---
async function autoFillFormLogic(page, sendEvent) {
    const url = page.url();
    const isGoogleForm = url.includes('docs.google.com/forms') || 
                         await page.evaluate(() => document.querySelector('form[action*="docs.google.com/forms"]') !== null || document.querySelector('div[role="listitem"]') !== null);

    let screenshot;
    if (isGoogleForm) {
        sendEvent('log', 'Detected Google Form. Analyzing fields...');
        
        const fields = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
            return items.map((item, idx) => {
                const headingEl = item.querySelector('div[role="heading"]');
                const title = headingEl ? headingEl.innerText.replace(/\s*\*$/, '').trim() : `Question ${idx + 1}`;
                
                const textInput = item.querySelector('input[type="text"], input[type="email"], input[type="number"], input[type="url"]');
                const textarea = item.querySelector('textarea');
                const radioGroup = item.querySelector('div[role="radiogroup"]');
                const checkboxes = item.querySelectorAll('div[role="checkbox"]');
                
                let type = 'text';
                if (textInput) type = 'text';
                else if (textarea) type = 'textarea';
                else if (radioGroup) type = 'radio';
                else if (checkboxes.length > 0) type = 'checkbox';
                else type = 'unknown';
                
                return { index: idx, title, type };
            });
        });

        sendEvent('log', `Found ${fields.length} fields. Starting automatic fill...`);

        for (const field of fields) {
            if (field.type === 'unknown') continue;

            if (field.type === 'text' || field.type === 'textarea') {
                const val = await getLLMResponse(field.title);
                sendEvent('log', `Filling text field "${field.title}" with "${val}"...`);
                
                const inputSelector = `div[role="listitem"]:nth-child(${field.index + 1}) input[type="text"], div[role="listitem"]:nth-child(${field.index + 1}) textarea`;
                try {
                    const locator = page.locator(inputSelector).first();
                    await locator.click({ timeout: 3000 });
                    await page.keyboard.down('Control');
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up('Control');
                    await page.keyboard.press('Backspace');
                    await locator.pressSequentially(val, { delay: 50, timeout: 3000 });
                } catch (e) {
                    sendEvent('log', `[Warning] Failed to fill "${field.title}": ${e.message}`);
                }
            } else if (field.type === 'radio') {
                sendEvent('log', `Selecting option for radio field "${field.title}"...`);
                try {
                    const radioSelector = `div[role="listitem"]:nth-child(${field.index + 1}) div[role="radio"]`;
                    const radios = page.locator(radioSelector);
                    if (await radios.count() > 0) {
                        await radios.nth(0).click({ timeout: 3000 });
                    }
                } catch (e) {
                    sendEvent('log', `[Warning] Failed to select radio for "${field.title}": ${e.message}`);
                }
            } else if (field.type === 'checkbox') {
                sendEvent('log', `Checking option for checkbox field "${field.title}"...`);
                try {
                    const checkboxSelector = `div[role="listitem"]:nth-child(${field.index + 1}) div[role="checkbox"]`;
                    const checkboxes = page.locator(checkboxSelector);
                    if (await checkboxes.count() > 0) {
                        await checkboxes.nth(0).click({ timeout: 3000 });
                    }
                } catch (e) {
                    sendEvent('log', `[Warning] Failed to check checkbox for "${field.title}": ${e.message}`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 800));
            screenshot = (await page.screenshot()).toString('base64');
            sendEvent('screenshot', screenshot);
        }

        sendEvent('log', 'Submitting form...');
        const submitted = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
            const submitBtn = buttons.find(b => {
                const txt = b.innerText.toLowerCase();
                return txt.includes('submit') || txt.includes('send') || txt.includes('next');
            });
            if (submitBtn) {
                submitBtn.click();
                return true;
            }
            return false;
        });

        if (submitted) {
            sendEvent('log', 'Form submitted. Waiting for confirmation page...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            screenshot = (await page.screenshot()).toString('base64');
            sendEvent('screenshot', screenshot);
            sendEvent('log', 'Success! Google Form fill complete.');
        } else {
            sendEvent('log', '[Warning] Submit button not found. Please click it manually if in Headed mode.');
        }

    } else {
        sendEvent('log', 'Analyzing general page for form elements...');
        
        const fields = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select'));
            return inputs.map((input, idx) => {
                const id = input.id;
                const name = input.name;
                const placeholder = input.placeholder;
                let labelText = '';
                if (id) {
                    const label = document.querySelector(`label[for="${id}"]`);
                    if (label) labelText = label.innerText;
                }
                if (!labelText) {
                    const parentLabel = input.closest('label');
                    if (parentLabel) labelText = parentLabel.innerText;
                }
                const title = labelText.trim() || placeholder || name || id || `Input ${idx + 1}`;
                
                let type = 'text';
                if (input.tagName.toLowerCase() === 'textarea') type = 'textarea';
                else if (input.tagName.toLowerCase() === 'select') type = 'select';
                else if (input.type === 'checkbox') type = 'checkbox';
                else if (input.type === 'radio') type = 'radio';
                
                return { index: idx, title, type };
            });
        });

        if (fields.length > 0) {
            sendEvent('log', `Detected ${fields.length} input fields on this page. Filling them...`);
            for (const field of fields) {
                const val = await getLLMResponse(field.title);
                sendEvent('log', `Filling standard field "${field.title}" with "${val}"...`);
                
                await page.evaluate(({ idx, val }) => {
                    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select'));
                    const input = inputs[idx];
                    if (input) {
                        if (input.tagName.toLowerCase() === 'select') {
                            if (input.options.length > 1) {
                                input.selectedIndex = 1;
                            }
                        } else if (input.type === 'checkbox' || input.type === 'radio') {
                            input.checked = true;
                        } else {
                            input.value = val;
                        }
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, { idx: field.index, val });

                await new Promise(resolve => setTimeout(resolve, 500));
                screenshot = (await page.screenshot()).toString('base64');
                sendEvent('screenshot', screenshot);
            }

            sendEvent('log', 'Form filled. Checking for submit button...');
            const clickedSubmit = await page.evaluate(() => {
                const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
                if (submitBtn) {
                    submitBtn.click();
                    return true;
                }
                const buttons = Array.from(document.querySelectorAll('button, a.btn'));
                const commonSubmit = buttons.find(b => {
                    const txt = b.innerText.toLowerCase();
                    return txt.includes('submit') || txt.includes('register') || txt.includes('sign up') || txt.includes('save');
                });
                if (commonSubmit) {
                    commonSubmit.click();
                    return true;
                }
                return false;
            });

            if (clickedSubmit) {
                sendEvent('log', 'Submitted form. Waiting for navigation...');
                await new Promise(resolve => setTimeout(resolve, 3000));
                screenshot = (await page.screenshot()).toString('base64');
                sendEvent('screenshot', screenshot);
            }
        } else {
            sendEvent('log', 'No form fields to fill. Monitoring complete.');
        }
    }
}

// --- AGENTIC SOLVER INTERACTIVE ACTIONS & REUSE LOGIC ---
const MAX_TAB_LIMIT = 5;

const openOrReuseTab = async (context, browserState, url, sendEvent) => {
    const targetUrl = url || 'about:blank';
    
    // 1. Check if we already have a page with the target URL
    if (targetUrl !== 'about:blank') {
        for (const page of browserState.pages) {
            if (!page.isClosed() && page.url() === targetUrl) {
                browserState.activePage = page;
                await page.bringToFront();
                sendEvent('log', `[System] Reused existing tab for URL: ${targetUrl}`);
                return page;
            }
        }
    }
    
    // 2. Check if we can open a new page (under limit)
    if (browserState.pages.size < MAX_TAB_LIMIT) {
        const newPage = await context.newPage();
        newPage._isAgentOwned = true;
        registerPage(newPage);
        if (targetUrl !== 'about:blank') {
            await newPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
        browserState.activePage = newPage;
        await newPage.bringToFront();
        return newPage;
    }
    
    // 3. Exceeded limit: Reuse oldest inactive page
    let pageToReuse = null;
    for (const page of browserState.pages) {
        if (page !== browserState.activePage && !page.isClosed()) {
            pageToReuse = page;
            break;
        }
    }
    if (!pageToReuse) {
        pageToReuse = browserState.activePage;
    }
    
    sendEvent('log', `[System] Max tab limit reached (${MAX_TAB_LIMIT}). Reusing tab: ${pageToReuse.url()} -> ${targetUrl}`);
    if (targetUrl !== 'about:blank') {
        await pageToReuse.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    } else {
        await pageToReuse.goto('about:blank').catch(() => {});
    }
    browserState.activePage = pageToReuse;
    await pageToReuse.bringToFront();
    return pageToReuse;
};

const handlePopupsAndChallenges = async (page, sendEvent) => {
    if (!page || page.isClosed()) return;
    
    try {
        // 1. Detect and auto-click Cloudflare checkbox if present in frames
        const frames = page.frames();
        const cfFrame = frames.find(f => f.url().includes('challenges.cloudflare.com'));
        if (cfFrame) {
            const selectors = ['input[type="checkbox"]', '#challenge-stage', '.ctp-checkbox-label', '.mark', 'span.mark', '#cf-stage', '.cb-i'];
            for (const selector of selectors) {
                try {
                    const el = cfFrame.locator(selector).first();
                    if (await el.count() > 0) {
                        await el.click({ timeout: 1500 });
                        sendEvent('log', `[System] Auto-clicked Cloudflare checkbox inside iframe: ${selector}`);
                        await page.waitForTimeout(1000);
                        break;
                    }
                } catch (e) {}
            }
        }

        // 2. Dismiss cookie banners and newsletter modals
        const clickedPopup = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
            
            // Cookie consent
            const acceptBtn = buttons.find(btn => {
                const txt = btn.innerText.toLowerCase();
                return (txt.includes('accept') || txt.includes('agree') || txt.includes('allow') || txt.includes('consent') || txt.includes('okay') || txt.includes('got it')) && 
                       (txt.includes('cookie') || txt.includes('all') || txt.includes('policy') || txt.includes('track') || txt.includes('privacy'));
            });
            if (acceptBtn && acceptBtn.click) {
                acceptBtn.click();
                return 'Cookie Consent Banner';
            }
            
            // Modal close
            const closeBtn = buttons.find(btn => {
                const cls = (btn.className || '').toLowerCase();
                const id = (btn.id || '').toLowerCase();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const title = (btn.getAttribute('title') || '').toLowerCase();
                const txt = btn.innerText.trim();
                const isCloseName = txt === '×' || txt === 'X' || txt.toLowerCase() === 'close' || txt.toLowerCase() === 'dismiss' || txt.toLowerCase() === 'no thanks' || txt.toLowerCase() === 'maybe later' || aria === 'close' || id.includes('close') || cls.includes('close') || title.includes('close');
                const hasModalVisible = document.querySelector('.modal, .popup, .dialog, [class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="dialog" i]') !== null;
                return isCloseName && hasModalVisible;
            });
            if (closeBtn && closeBtn.click) {
                closeBtn.click();
                return 'Modal Popup / Overlay';
            }
            return null;
        }).catch(() => null);

        if (clickedPopup) {
            sendEvent('log', `[System] Dismissed popup in main execution pipeline: ${clickedPopup}`);
            await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1000);
        }
    } catch (err) {
        // Ignore errors during popup handling
    }
};

const isDuplicateAction = (action, actionHistory) => {
    if (!actionHistory || actionHistory.length === 0) return false;
    const now = Date.now();
    const windowMs = 15000; // 15 seconds window
    
    // Look at the last few actions
    for (let i = actionHistory.length - 1; i >= 0; i--) {
        const past = actionHistory[i];
        if (now - past.timestamp > windowMs) break;
        
        if (past.type === action.type) {
            if (action.type === 'click' && past.selector === action.selector) return true;
            if (action.type === 'type' && past.selector === action.selector && past.value === action.value) return true;
            if (action.type === 'navigate' && past.url === action.url) return true;
            if (action.type === 'openTab' && past.url === action.url) return true;
            if (action.type === 'pressKey' && past.key === action.key) return true;
        }
    }
    return false;
};

const startPageObserver = (pageGetter, sendEvent, headless, state, browserState) => {
    const run = async () => {
        while (state.running) {
            try {
                if (browserState && browserState.taskState && browserState.taskState.isExecutingAction) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }
                const page = pageGetter();
                if (!page || page.isClosed()) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                }

                // Unified Authentication & CAPTCHA Detection
                const authState = await page.evaluate(() => {
                    const url = window.location.href.toLowerCase();
                    const text = document.body ? document.body.innerText.toLowerCase() : '';
                    const title = document.title ? document.title.toLowerCase() : '';
                    
                    const isElementVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 20 && rect.height > 20 && 
                               style.display !== 'none' && 
                               style.visibility !== 'hidden' && 
                               style.opacity !== '0';
                    };

                    const hasVisibleTurnstile = () => {
                        const frames = Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]'));
                        return frames.some(isElementVisible);
                    };

                    const hasVisibleCaptchaWidget = () => {
                        const frames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'));
                        return frames.some(isElementVisible);
                    };

                    const cfStage = document.querySelector('#challenge-stage');
                    const cfChallenge = document.querySelector('#cf-challenge');
                    const hasCFStage = cfStage && isElementVisible(cfStage);
                    const hasCFChallenge = cfChallenge && isElementVisible(cfChallenge);

                    const isCFPage = (title.includes('just a moment') || title.includes('verify you are human') || title.includes('cloudflare')) &&
                                     (text.includes('verify you are human') || text.includes('checking your browser') || text.includes('cloudflare'));

                    const hasCaptcha = hasVisibleTurnstile() || hasVisibleCaptchaWidget() || hasCFStage || hasCFChallenge || isCFPage;
                    
                    const hasInput = document.querySelector('input') !== null;
                    
                    const hasOtp = hasInput && (
                                   text.includes('enter otp') || text.includes('verification code') || text.includes('one-time password') || 
                                   text.includes('code sent') || text.includes('digit code') || url.includes('otp') ||
                                   document.querySelector('input[name*="otp" i]') !== null || document.querySelector('input[id*="otp" i]') !== null ||
                                   document.querySelector('input[placeholder*="code" i]') !== null
                                   );

                    const has2FA = hasInput && (
                                   text.includes('two-factor') || text.includes('2fa') || text.includes('mfa') || 
                                   text.includes('multi-factor') || text.includes('auth app') || text.includes('security key') ||
                                   text.includes('approve the sign-in') || text.includes('google authenticator')
                                   );

                    const hasEmailVerif = text.includes('verify your email') || text.includes('email verification') || 
                                          text.includes('confirm your email') || url.includes('email-verification');

                    const hasCheckpoint = text.includes('security checkpoint') || text.includes('confirm your identity') || 
                                          text.includes('unusual activity') || url.includes('checkpoint');

                    const hasPassword = document.querySelector('input[type="password"]') !== null;
                    const isSignup = url.includes('signup') || url.includes('register') || text.includes('create account') || text.includes('sign up');
                    const isLogin = url.includes('login') || url.includes('signin') || url.includes('auth') || url.includes('accounts.google') ||
                                    text.includes('sign in') || text.includes('log in');

                    if (hasCaptcha) return { type: 'CAPTCHA', description: 'CAPTCHA / Cloudflare human verification challenge' };
                    if (hasOtp) return { type: 'OTP', description: 'One-Time Password (OTP) verification screen' };
                    if (has2FA) return { type: '2FA', description: 'Two-Factor / Multi-Factor Authentication prompt' };
                    if (hasEmailVerif) return { type: 'Email Verification', description: 'Email verification screen' };
                    if (hasCheckpoint) return { type: 'Security Checkpoint', description: 'Security identity checkpoint' };
                    if (isSignup) return { type: 'Signup', description: 'Signup / Registration page' };
                    if (hasPassword && isLogin) return { type: 'Login', description: 'Login / Sign-in page' };
                    
                    return null;
                });

                if (authState) {
                    if (!state.loginPrompted) {
                        state.loginPrompted = true;
                        state.interrupted = true;
                        sendEvent('log', `[Pause] Human intervention required: ${authState.description}. Pausing automation.`);
                    }

                    // Emit pause event
                    const ss = (await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => Buffer.from(''))).toString('base64');
                    sendEvent('pause', {
                        sessionId: state.sessionId,
                        type: authState.type,
                        description: authState.description,
                        url: page.url(),
                        title: await page.title().catch(() => 'Unknown Page'),
                        screenshot: ss
                    });

                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                } else {
                    if (state.loginPrompted) {
                        state.loginPrompted = false;
                        state.interrupted = false;
                        sendEvent('log', '[System] Human verification / Login complete. Resuming automation task...');
                        sendEvent('resume', { sessionId: state.sessionId });

                        // Save session post-login
                        const domain = getDomainFromUrl(page.url());
                        if (domain) {
                            const sessionInfo = activeSessions.get(state.sessionId);
                            if (sessionInfo) {
                                await saveBrowserSession(page, sessionInfo.context, domain);
                            }
                        }
                    }
                }

                if (state.interrupted) {
                    sendEvent('log', '[System] Interruption resolved. Resuming automation task...');
                    state.interrupted = false;
                }
            } catch (err) {
                // Ignore errors
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    };
    run();
};

const executeWithRetry = async (fn, retries = 2, delay = 1000) => {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

const agenticType = async (page, targetSelector, value) => {
    // 1. Try standard Playwright wait and fill/pressSequentially
    try {
        const locator = page.locator(targetSelector).first();
        await executeWithRetry(async () => {
            await locator.fill('', { timeout: 2000 });
            await locator.pressSequentially(value, { delay: 30, timeout: 2000 });
        });
        return true;
    } catch (err) {
        console.log(`Playwright fill/pressSequentially failed on ${targetSelector}: ${err.message}. Trying direct JS value assignment...`);
        try {
            const typed = await page.evaluate(({ sel, val }) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.focus();
                    if (el.tagName.toLowerCase() !== 'div') {
                        el.value = val;
                    } else {
                        el.innerText = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }, { sel: targetSelector, val: value });
            if (typed) {
                await page.keyboard.press('Space');
                await page.keyboard.press('Backspace');
                return true;
            }
        } catch (e) {}
        console.log(`Direct JS type failed. Trying agentic DOM search...`);
    }

    // 2. Agentic DOM search & JS value assignment
    const success = await page.evaluate(({ sel, val }) => {
        const candidates = Array.from(document.querySelectorAll('input, textarea, div[contenteditable="true"]'));
        const visibleInputs = candidates.filter(el => {
            if (el.tagName.toLowerCase() === 'input') {
                const type = el.type ? el.type.toLowerCase() : 'text';
                if (['hidden', 'submit', 'button', 'file', 'image', 'checkbox', 'radio'].includes(type)) return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && 
                   window.getComputedStyle(el).display !== 'none' && 
                   window.getComputedStyle(el).visibility !== 'hidden';
        });

        if (visibleInputs.length === 0) return false;

        let targetEl = null;
        try {
            targetEl = document.querySelector(sel);
            if (targetEl && !visibleInputs.includes(targetEl)) targetEl = null;
        } catch (e) {}

        if (!targetEl) {
            targetEl = visibleInputs.find(el => {
                const placeholder = (el.placeholder || '').toLowerCase();
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                return placeholder.includes('search') || placeholder.includes('prompt') || placeholder.includes('chat') || placeholder.includes('ask') || placeholder.includes('find') || placeholder.includes('message') ||
                       label.includes('search') || label.includes('prompt') || label.includes('chat') || label.includes('ask') || label.includes('message');
            });
        }

        if (!targetEl) {
            targetEl = visibleInputs.find(el => el.tagName.toLowerCase() === 'textarea') || visibleInputs[0];
        }

        if (targetEl) {
            targetEl.focus();
            if (targetEl.setAttribute && targetEl.tagName.toLowerCase() !== 'div') {
                targetEl.value = val;
            } else {
                targetEl.innerText = val;
            }
            targetEl.dispatchEvent(new Event('input', { bubbles: true }));
            targetEl.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        return false;
    }, { sel: targetSelector, val: value });

    if (success) {
        await page.keyboard.press('Space');
        await page.keyboard.press('Backspace');
        return true;
    }
    throw new Error('No visible text input or editor found on this page.');
};

const agenticSubmit = async (page) => {
    try {
        await page.keyboard.press('Enter');
    } catch (e) {}

    const success = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
        const visibleButtons = buttons.filter(btn => {
            const rect = btn.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && 
                   window.getComputedStyle(btn).display !== 'none' && 
                   window.getComputedStyle(btn).visibility !== 'hidden';
        });

        const submitBtn = visibleButtons.find(btn => {
            const text = btn.innerText.toLowerCase();
            const title = (btn.getAttribute('title') || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            return text.includes('search') || text.includes('submit') || text.includes('send') || text.includes('go') || text.includes('find') ||
                   title.includes('search') || title.includes('submit') || title.includes('send') || title.includes('go') ||
                   aria.includes('search') || aria.includes('submit') || aria.includes('send') || aria.includes('go');
        });

        if (submitBtn) {
            submitBtn.click();
            return true;
        }

        const form = document.querySelector('form');
        if (form) {
            form.submit();
            return true;
        }

        if (visibleButtons.length > 0) {
            visibleButtons[0].click();
            return true;
        }
        return false;
    });

    return success;
};

const agenticClick = async (page, targetSelector, description, sendEvent) => {
    // 1. Try standard Playwright click with built-in auto-waiting & forced click fallback
    try {
        sendEvent('log', `[System] Clicking selector "${targetSelector}"...`);
        const locator = page.locator(targetSelector).first();
        
        await executeWithRetry(async () => {
            try {
                await locator.click({ timeout: 2000 });
            } catch (e) {
                await locator.click({ force: true, timeout: 2000 });
            }
        });
        
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        return true;
    } catch (err) {
        console.log(`Playwright click failed on ${targetSelector}: ${err.message}. Trying direct JS click...`);
        try {
            const clicked = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) { el.focus(); el.click(); return true; }
                return false;
            }, targetSelector);
            if (clicked) {
                await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
                return true;
            }
        } catch (e) {}
        console.log(`Direct JS click failed on ${targetSelector}. Trying self-healing element search...`);
    }

    // 2. Self-healing DOM search (Aria labels, Roles, Text contents)
    const success = await page.evaluate(({ sel, desc }) => {
        const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], div[role="button"], span, div'));
        
        // Find visible clickable elements
        const visibleElements = candidates.filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && 
                   window.getComputedStyle(el).display !== 'none' && 
                   window.getComputedStyle(el).visibility !== 'hidden';
        });

        if (visibleElements.length === 0) return false;

        // Try exact selector match first
        let targetEl = null;
        try {
            targetEl = document.querySelector(sel);
            if (targetEl && !visibleElements.includes(targetEl)) targetEl = null;
        } catch (e) {}

        // Match by description text
        if (!targetEl && desc) {
            const cleanDesc = desc.toLowerCase();
            targetEl = visibleElements.find(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const title = (el.getAttribute('title') || '').toLowerCase();
                return (text.length > 2 && cleanDesc.includes(text)) || 
                       (aria && cleanDesc.includes(aria)) || 
                       (title && cleanDesc.includes(title));
            });
        }

        // Match by selector parts
        if (!targetEl) {
            const cleanSel = sel.toLowerCase();
            targetEl = visibleElements.find(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                return text && (cleanSel.includes(text) || text.includes(cleanSel));
            });
        }

        if (targetEl) {
            targetEl.focus();
            targetEl.click();
            return true;
        }
        return false;
    }, { sel: targetSelector, desc: description });

    if (success) {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        return true;
    }

    // 3. Coordinate Click Fallback (Visual match fallback)
    try {
        const locator = page.locator(targetSelector).first();
        const box = await locator.boundingBox();
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
            return true;
        }
    } catch (e) {}

    throw new Error(`Self-healing click failed: Unable to locate clickable element matching "${targetSelector}" or description.`);
};

const getInteractiveElements = async (page) => {
    return await page.evaluate(() => {
        // Find visible inputs
        const inputEls = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, div[contenteditable="true"]'));
        const inputs = inputEls.map(el => {
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
            if (!isVisible) return null;
            
            // Try to find label
            let labelText = '';
            if (el.id) {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label) labelText = label.innerText;
            }
            if (!labelText) {
                const parentLabel = el.closest('label');
                if (parentLabel) labelText = parentLabel.innerText;
            }
            // Fallback: Check for container elements with role="listitem" (like Google Forms question cards)
            if (!labelText) {
                const listitem = el.closest('div[role="listitem"]');
                if (listitem) {
                    const heading = listitem.querySelector('div[role="heading"]');
                    if (heading) labelText = heading.innerText;
                }
            }
            // Fallback: Check preceding siblings
            if (!labelText) {
                let sibling = el.previousElementSibling;
                while (sibling && !labelText) {
                    if (sibling.innerText && sibling.innerText.trim().length > 0) {
                        labelText = sibling.innerText;
                    }
                    sibling = sibling.previousElementSibling;
                }
            }
            // Fallback: attributes
            if (!labelText) {
                labelText = el.getAttribute('aria-label') || el.getAttribute('title') || '';
            }
            
            // Build selector
            let selector = el.tagName.toLowerCase();
            if (el.id) selector += `#${el.id}`;
            else if (el.name) selector += `[name="${el.name}"]`;
            else if (el.className) selector += `.${el.className.trim().split(/\s+/).join('.')}`;
            
            // Extract value safely
            let val = '';
            if (el.tagName.toLowerCase() !== 'div') {
                val = el.value || '';
            } else {
                val = el.innerText || '';
            }

            return {
                selector,
                placeholder: el.placeholder || '',
                label: labelText.replace(/\s*\*$/, '').trim(), // Remove asterisks commonly indicating required fields
                value: val.trim()
            };
        }).filter(Boolean);

        // Find visible buttons/links
        const buttonEls = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], div[role="button"]'));
        const buttons = buttonEls.map(el => {
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
            if (!isVisible) return null;
            
            const text = el.innerText ? el.innerText.trim().substring(0, 50) : '';
            const title = el.getAttribute('title') || '';
            const aria = el.getAttribute('aria-label') || '';
            
            if (!text && !title && !aria) return null; // Filter out blank buttons/links

            // Build selector
            let selector = el.tagName.toLowerCase();
            if (el.id) selector += `#${el.id}`;
            else if (el.className) selector += `.${el.className.trim().split(/\s+/).join('.')}`;
            
            return {
                selector,
                text,
                title,
                aria
            };
        }).filter(Boolean);

        return { 
            inputs: inputs.slice(0, 20), 
            buttons: buttons.slice(0, 40) 
        };
    });
};

const getNextAgentAction = async (goal, currentUrl, currentTitle, interactiveElements, accessibilityTree, history, visualGuidance = null, goalTracker = null, sendEvent = null) => {
    if (!GROQ_API_KEY) {
        return null;
    }
    
    let visualGuidanceText = '';
    if (visualGuidance) {
        visualGuidanceText = `
[VISUAL RECOVERY GUIDANCE]
The visual analyzer detected an obstacle. Use this guidance to bypass it:
- Reason: ${visualGuidance.reasoning}
- Recommended bypass action: ${visualGuidance.recommendation}
- Recovery Action: ${visualGuidance.action ? JSON.stringify(visualGuidance.action) : 'None'}
`;
    }

    let trackingText = '';
    if (goalTracker) {
        trackingText = `
[GOAL TRACKING STATUS]
- Original Goal: "${goalTracker.originalGoal}"
- Completed Steps:
${goalTracker.completedSteps.map((s, i) => `  - Step ${i + 1}: ${s}`).join('\n') || '  - None'}
- Failed Attempts:
${goalTracker.failedAttempts.map((f, i) => `  - Attempt ${i + 1}: Action [${f.action.type}] "${f.action.description || f.action.selector}" failed with error: "${f.error}"`).join('\n') || '  - None'}
`;
        if (goalTracker.context) {
            trackingText += `
[CONTEXT MEMORY]
- Pages Already Visited:
${goalTracker.context.pagesAlreadyVisited.map(p => `  - ${p}`).join('\n') || '  - None'}
- Open Tabs:
${goalTracker.context.openTabs.map(t => `  - Title: "${t.title}" | URL: ${t.url}`).join('\n') || '  - None'}
- Entered Form Data:
${Object.keys(goalTracker.context.formDataEntered).map(k => `  - Selector "${k}": "${goalTracker.context.formDataEntered[k]}"`).join('\n') || '  - None'}
- Search Queries Used:
${goalTracker.context.searchQueriesUsed.map(q => `  - "${q}"`).join('\n') || '  - None'}
- Downloaded Files:
${goalTracker.context.downloadedFiles.map(d => `  - ${d}`).join('\n') || '  - None'}
`;
        }
    }

    const prompt = `You are the brain of Paradox AI, a highly autonomous web agent.
Your overall goal: "${goal}"

Current page URL: ${currentUrl}
Current page title: "${currentTitle}"

${trackingText}

Execution History (actions already taken):
${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}
${visualGuidanceText}

Accessibility Tree of the page:
${accessibilityTree ? JSON.stringify(accessibilityTree, null, 2).substring(0, 3000) : 'Not available'}

Interactive Elements visible on the current page:
- Inputs:
${interactiveElements.inputs.map(inp => `  - Selector: "${inp.selector}" | Placeholder: "${inp.placeholder}" | Label: "${inp.label}" | Current Value: "${inp.value}"`).join('\n')}
- Clickable Buttons/Links:
${interactiveElements.buttons.map(btn => `  - Selector: "${btn.selector}" | Text: "${btn.text}" | Title: "${btn.title}" | Aria-label: "${btn.aria}"`).join('\n')}

Analyze the current page state (relying primarily on the DOM and accessibility tree), history, and overall goal.

CRITICAL GOAL AWARENESS & ACTION VERIFICATION:
Before deciding on the action, you MUST verify: "Does this action help achieve the original goal?"
If you identify that the action is a repeat of a failed action or does not align with the goal, or if you are stuck in a loop:
1. Trigger self-correction in the JSON response.
2. Choose a different, better recovery action, or re-plan your approach.

Determine the single next action to take to get closer to completing the goal.
If the goal is fully achieved, select status "complete".

If there was a failed attempt, an obstacle, or a loop (as shown in Goal Tracking, Context Memory, or Visual Recovery Guidance), you MUST populate the "selfCorrection" fields explaining:
1. "whatHappened": What failed or what obstacle is present.
2. "whyFailed": Why that action failed or why it is blocked.
3. "recoveryActionSelected": What specific approach is chosen to bypass this.
4. "whyNewActionSucceeds": Why this new action will succeed.
If there are no failures, obstacles, or loops, these fields can be empty strings ("").

You must respond with a JSON object conforming exactly to this schema:
{
  "status": "execute" | "complete" | "failed",
  "reasoning": "Brief explanation of your thinking (what you observed, obstacles, next steps)",
  "confidence": "High" | "Medium" | "Low",
  "selfCorrection": {
    "whatHappened": "What failed or what obstacle is present, or empty string",
    "whyFailed": "Why the previous action failed, or empty string",
    "recoveryActionSelected": "What specific approach is chosen to bypass, or empty string",
    "whyNewActionSucceeds": "Why this new action will succeed, or empty string"
  },
  "action": {
    "type": "type" | "click" | "pressKey" | "navigate",
    "selector": "CSS selector of the target element (if type or click)",
    "value": "Value to type (if type)",
    "key": "Key to press (if pressKey)",
    "url": "URL to navigate to (if navigate)",
    "description": "Short human-readable description of this action step"
  }
}

Respond ONLY with the JSON block. No explanation before or after.`;

    try {
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'You are an autonomous web browser agent.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                response_format: { type: "json_object" }
            })
        });
        const data = await response.json();
        const rawContent = data.choices[0].message.content.trim();
        const match = rawContent.match(/```json\s*([\s\S]*?)\s*```/) || rawContent.match(/```\s*([\s\S]*?)\s*```/);
        const jsonText = match ? match[1] : rawContent;
        return JSON.parse(jsonText.trim());
    } catch (err) {
        console.error("Error fetching next agent action:", err);
        if (sendEvent) {
            sendEvent('log', `[Error] AI Brain API Call failed: ${err.message}`);
        }
    }
    return null;
};

// --- HYBRID VISUAL OBSERVER & STATE COLLECTION ---
const collectBrowserState = async (page, goal, lastAction = null, lastOutcome = null) => {
    const url = page.url();
    const title = await page.title().catch(() => 'Unknown Page');
    const elements = await getInteractiveElements(page).catch(() => ({ inputs: [], buttons: [] }));
    const accessibilityTree = page.accessibility ? await page.accessibility.snapshot().catch(() => null) : null;
    
    // Check for visible dialogs or modals in DOM
    const hasVisibleModal = await page.evaluate(() => {
        const modalSelectors = ['.modal', '.popup', '.dialog', '[role="dialog"]', '[role="alertdialog"]', '[class*="modal" i]', '[class*="popup" i]', '[class*="dialog" i]', '[class*="overlay" i]'];
        for (const sel of modalSelectors) {
            try {
                const el = document.querySelector(sel);
                if (el) {
                    const rect = el.getBoundingClientRect();
                    const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
                    if (isVisible) return true;
                }
            } catch (e) {}
        }
        return false;
    });

    return {
        url,
        title,
        elements,
        accessibilityTree,
        hasVisibleModal,
        goal,
        lastAction,
        lastOutcome
    };
};

const detectVisualTriggers = (state, lastOutcome) => {
    // 1. Action failed
    if (lastOutcome && lastOutcome.success === false) {
        return { triggered: true, reason: `Action failed: ${lastOutcome.error}` };
    }

    // 2. Popup or Modal detected in DOM
    if (state.hasVisibleModal) {
        return { triggered: true, reason: 'Visible popup/modal dialog detected' };
    }

    // 3. Login or verification keywords in title or URL
    const urlLower = state.url.toLowerCase();
    const titleLower = state.title.toLowerCase();
    
    if (urlLower.includes('login') || urlLower.includes('signin') || urlLower.includes('signup') || urlLower.includes('auth') || urlLower.includes('verification') || urlLower.includes('otp')) {
        return { triggered: true, reason: 'Login, authentication, or verification screen detected' };
    }

    // 4. Cloudflare / CAPTCHA screen
    if (titleLower.includes('just a moment') || titleLower.includes('cloudflare') || titleLower.includes('captcha') || titleLower.includes('verify you are human')) {
        return { triggered: true, reason: 'Cloudflare / CAPTCHA challenge screen detected' };
    }

    // 5. Cookie consent or Privacy Banner keywords in title/URL
    if (titleLower.includes('cookie') || titleLower.includes('consent') || titleLower.includes('privacy policy') || urlLower.includes('cookie') || urlLower.includes('consent')) {
        return { triggered: true, reason: 'Cookie consent banner or privacy prompt detected' };
    }

    // 6. Unexpected error / Access blocked pages
    if (titleLower.includes('error') || titleLower.includes('404') || titleLower.includes('502') || titleLower.includes('forbidden') || titleLower.includes('access denied') || titleLower.includes('blocked') || titleLower.includes('not found')) {
        return { triggered: true, reason: 'Unexpected error page or access restriction page detected' };
    }

    return { triggered: false, reason: '' };
};

const getMemoryHash = (command) => {
    return crypto.createHash('md5').update(command.trim().toLowerCase()).digest('hex');
};

const createAgentMemory = (command) => {
    return {
        task: {
            goal: command,
            startTime: new Date().toISOString(),
            status: 'running',
            currentPage: 'Unknown',
            currentUrl: 'about:blank',
            lastAction: null,
            nextIntendedAction: null
        },
        progress: {
            completedSteps: [],
            pendingSteps: [],
            failedSteps: [],
            retryCount: 0
        },
        failures: {
            failedSelectors: [],
            failedActions: [],
            failedNavigations: []
        },
        context: {
            openTabs: [],
            downloadedFiles: [],
            formDataEntered: {},
            searchQueriesUsed: [],
            pagesAlreadyVisited: []
        },
        internalSummary: {
            goal: command,
            currentProgress: "Initialized browser.",
            currentObstacle: "None",
            currentPlan: "Start navigation."
        },
        toolMemory: {
            recentlyUsedTools: [],
            toolOutputs: {},
            failedToolAttempts: [],
            currentToolState: {}
        }
    };
};

const saveMemoryToDisk = (sessionId, memory) => {
    try {
        const filePath = path.join(tempDir, `memory_${sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf8');
    } catch (e) {
        console.error("[System] Failed to save memory to disk:", e);
    }
};

const loadMemoryFromDisk = (sessionId) => {
    try {
        const filePath = path.join(tempDir, `memory_${sessionId}.json`);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(content);
        }
    } catch (e) {
        console.error("[System] Failed to load memory from disk:", e);
    }
    return null;
};

const emitInternalSummary = (memory, sendEvent) => {
    if (memory && memory.internalSummary) {
        sendEvent('summary', memory.internalSummary);
    }
};

// --- PHASE 7: TOOL ECOSYSTEM ---
const TOOL_REGISTRY = {
    browser: {
        name: 'Browser Tool',
        description: 'Navigate websites, click elements, fill forms, manage tabs',
        capabilities: ['navigate', 'click', 'type', 'pressKey', 'switchTab', 'closeTab', 'openTab', 'screenshot'],
        requiresBrowser: true
    },
    file: {
        name: 'File Tool',
        description: 'Read, create, rename, delete, move, and search files on the local filesystem',
        capabilities: ['readFile', 'createFile', 'renameFile', 'deleteFile', 'moveFile', 'searchFiles', 'listFiles'],
        requiresBrowser: false
    },
    terminal: {
        name: 'Terminal Tool',
        description: 'Execute safe terminal commands, run scripts, install dependencies, capture output',
        capabilities: ['runCommand'],
        requiresBrowser: false
    },
    download: {
        name: 'Download Manager',
        description: 'Track and manage browser downloads, locate and open downloaded files',
        capabilities: ['waitForDownload', 'listDownloads', 'openDownload'],
        requiresBrowser: true
    }
};

const WORKSPACE_DIR = path.join(__dirname, 'workspace');
if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const DOWNLOADS_DIR = path.join(tempDir, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const SAFE_FILE_DIRS = [tempDir, WORKSPACE_DIR];
const sessionDownloads = new Map();

const isPathSafe = (targetPath) => {
    const resolved = path.resolve(targetPath);
    return SAFE_FILE_DIRS.some(dir => resolved.startsWith(path.resolve(dir)));
};

// --- FILE TOOL ---
const executeFileTool = async (action, sendEvent) => {
    const actionType = action.type;
    try {
        switch (actionType) {
            case 'readFile': {
                const filePath = path.resolve(action.path);
                if (!isPathSafe(filePath)) return { success: false, error: `Access denied: "${action.path}" is outside allowed directories` };
                if (!fs.existsSync(filePath)) return { success: false, error: `File not found: "${action.path}"` };
                const stats = fs.statSync(filePath);
                if (stats.size > 1024 * 1024) return { success: false, error: `File too large (${(stats.size / 1024).toFixed(1)}KB). Max 1MB.` };
                const ext = path.extname(filePath).toLowerCase();
                if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.pdf'].includes(ext)) {
                    sendEvent('tool', { tool: 'File', message: `Read metadata: ${path.basename(filePath)} (${(stats.size / 1024).toFixed(1)}KB)` });
                    return { success: true, output: { type: 'binary_metadata', filename: path.basename(filePath), size: stats.size, extension: ext, modified: stats.mtime.toISOString() } };
                }
                const content = fs.readFileSync(filePath, 'utf8');
                sendEvent('tool', { tool: 'File', message: `Read file: ${path.basename(filePath)} (${content.length} chars)` });
                return { success: true, output: { type: 'text', filename: path.basename(filePath), content: content.substring(0, 5000), truncated: content.length > 5000 } };
            }
            case 'createFile': {
                const filePath = path.resolve(action.path);
                if (!isPathSafe(filePath)) return { success: false, error: `Access denied: "${action.path}" is outside allowed directories` };
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, action.content || '', 'utf8');
                sendEvent('tool', { tool: 'File', message: `Created file: ${path.basename(filePath)}` });
                return { success: true, output: { created: filePath } };
            }
            case 'renameFile': {
                const oldPath = path.resolve(action.path);
                const newPath = path.resolve(action.newPath || action.value);
                if (!isPathSafe(oldPath) || !isPathSafe(newPath)) return { success: false, error: 'Access denied: path is outside allowed directories' };
                if (!fs.existsSync(oldPath)) return { success: false, error: `File not found: "${action.path}"` };
                fs.renameSync(oldPath, newPath);
                sendEvent('tool', { tool: 'File', message: `Renamed: ${path.basename(oldPath)} \u2192 ${path.basename(newPath)}` });
                return { success: true, output: { renamed: { from: oldPath, to: newPath } } };
            }
            case 'deleteFile': {
                const filePath = path.resolve(action.path);
                if (!isPathSafe(filePath)) return { success: false, error: `Access denied: "${action.path}" is outside allowed directories` };
                if (!fs.existsSync(filePath)) return { success: false, error: `File not found: "${action.path}"` };
                fs.unlinkSync(filePath);
                sendEvent('tool', { tool: 'File', message: `Deleted: ${path.basename(filePath)}` });
                return { success: true, output: { deleted: filePath } };
            }
            case 'moveFile': {
                const srcPath = path.resolve(action.path);
                const destPath = path.resolve(action.destination || action.value);
                if (!isPathSafe(srcPath) || !isPathSafe(destPath)) return { success: false, error: 'Access denied: path is outside allowed directories' };
                if (!fs.existsSync(srcPath)) return { success: false, error: `File not found: "${action.path}"` };
                const destDir = path.dirname(destPath);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                fs.renameSync(srcPath, destPath);
                sendEvent('tool', { tool: 'File', message: `Moved: ${path.basename(srcPath)} \u2192 ${destPath}` });
                return { success: true, output: { moved: { from: srcPath, to: destPath } } };
            }
            case 'searchFiles': {
                const searchDir = action.path ? path.resolve(action.path) : WORKSPACE_DIR;
                if (!isPathSafe(searchDir)) return { success: false, error: 'Access denied: directory is outside allowed directories' };
                const pattern = (action.value || action.query || '').toLowerCase();
                const results = [];
                const searchRecursive = (dir) => {
                    if (!fs.existsSync(dir)) return;
                    try {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) searchRecursive(fullPath);
                            else if (entry.name.toLowerCase().includes(pattern)) {
                                const stats = fs.statSync(fullPath);
                                results.push({ name: entry.name, path: fullPath, size: stats.size, modified: stats.mtime.toISOString() });
                            }
                            if (results.length >= 50) return;
                        }
                    } catch (e) {}
                };
                searchRecursive(searchDir);
                sendEvent('tool', { tool: 'File', message: `Search "${pattern}" found ${results.length} files` });
                return { success: true, output: { results, count: results.length } };
            }
            case 'listFiles': {
                const listDir = action.path ? path.resolve(action.path) : WORKSPACE_DIR;
                if (!isPathSafe(listDir)) return { success: false, error: 'Access denied: directory is outside allowed directories' };
                if (!fs.existsSync(listDir)) return { success: false, error: `Directory not found: "${action.path}"` };
                const entries = fs.readdirSync(listDir, { withFileTypes: true });
                const files = entries.map(e => ({
                    name: e.name,
                    isDirectory: e.isDirectory(),
                    size: e.isFile() ? fs.statSync(path.join(listDir, e.name)).size : null
                }));
                sendEvent('tool', { tool: 'File', message: `Listed ${files.length} items in ${path.basename(listDir) || listDir}` });
                return { success: true, output: { directory: listDir, files } };
            }
            default:
                return { success: false, error: `Unknown file action: ${actionType}` };
        }
    } catch (err) {
        return { success: false, error: err.message };
    }
};

// --- TERMINAL TOOL ---
const TERMINAL_WHITELIST = ['dir', 'ls', 'cat', 'type', 'echo', 'mkdir', 'md', 'copy', 'xcopy', 'move', 'ren', 'find', 'findstr', 'sort', 'more', 'tree', 'set', 'cd', 'cls', 'date', 'time', 'ver', 'systeminfo', 'hostname', 'whoami', 'ipconfig', 'ping', 'nslookup', 'tracert', 'curl', 'where', 'node', 'python', 'python3', 'npm', 'npx', 'pip', 'pip3', 'git', 'powershell', 'pwsh', 'code'];
const TERMINAL_BLACKLIST = [
    /rm\s+-rf\s+\//i, /format\s+[a-z]:/i, /del\s+\/s\s+\/q\s+[a-z]:\\/i,
    /shutdown/i, /restart\s+-/i, /taskkill\s+\/f\s+\/im/i,
    /reg\s+(delete|add)/i, /bcdedit/i, /diskpart/i,
    /net\s+(user|localgroup)/i, /schtasks/i
];

const isCommandSafe = (command) => {
    const cmd = command.trim();
    for (const pattern of TERMINAL_BLACKLIST) {
        if (pattern.test(cmd)) return { safe: false, reason: 'Blocked by security policy: matches dangerous pattern' };
    }
    const firstToken = cmd.split(/\s+/)[0].toLowerCase().replace(/\.exe$/i, '');
    if (!TERMINAL_WHITELIST.includes(firstToken)) {
        return { safe: false, reason: `Command "${firstToken}" is not in the allowed commands list` };
    }
    return { safe: true };
};

const executeTerminalTool = async (action, sendEvent) => {
    const command = action.command || action.value;
    if (!command) return { success: false, error: 'No command specified' };

    const safety = isCommandSafe(command);
    if (!safety.safe) {
        sendEvent('tool', { tool: 'Terminal', message: `\u26D4 Command blocked: ${safety.reason}` });
        return { success: false, error: safety.reason };
    }

    sendEvent('tool', { tool: 'Terminal', message: `Executing: ${command}` });

    return new Promise((resolve) => {
        exec(command, { timeout: 30000, maxBuffer: 1024 * 1024, cwd: WORKSPACE_DIR, shell: true }, (error, stdout, stderr) => {
            const truncStdout = stdout ? stdout.substring(0, 10240) : '';
            const truncStderr = stderr ? stderr.substring(0, 5120) : '';
            if (error && error.killed) {
                sendEvent('tool', { tool: 'Terminal', message: '\u23F1\uFE0F Command timed out after 30s' });
                resolve({ success: false, error: 'Command timed out after 30 seconds', stdout: truncStdout, stderr: truncStderr, exitCode: error.code });
            } else if (error) {
                sendEvent('tool', { tool: 'Terminal', message: `\u274C Exit code ${error.code}: ${truncStderr || error.message}` });
                resolve({ success: false, error: truncStderr || error.message, stdout: truncStdout, stderr: truncStderr, exitCode: error.code });
            } else {
                sendEvent('tool', { tool: 'Terminal', message: `\u2705 Completed${truncStdout ? ` (${truncStdout.split('\\n').length} lines)` : ''}` });
                resolve({ success: true, stdout: truncStdout, stderr: truncStderr, exitCode: 0 });
            }
        });
    });
};

// --- DOWNLOAD MANAGER ---
const executeDownloadTool = async (action, page, sendEvent, sessionId) => {
    try {
        switch (action.type) {
            case 'waitForDownload': {
                sendEvent('tool', { tool: 'Download', message: 'Waiting for download to start...' });
                const download = await page.waitForEvent('download', { timeout: 15000 });
                const filename = download.suggestedFilename();
                const savePath = path.join(DOWNLOADS_DIR, filename);
                await download.saveAs(savePath);
                const stats = fs.statSync(savePath);
                const entry = { filename, path: savePath, status: 'complete', startTime: new Date().toISOString(), size: stats.size };
                if (!sessionDownloads.has(sessionId)) sessionDownloads.set(sessionId, []);
                sessionDownloads.get(sessionId).push(entry);
                sendEvent('tool', { tool: 'Download', message: `\u2705 Downloaded: ${filename} (${(stats.size / 1024).toFixed(1)}KB)` });
                return { success: true, output: entry };
            }
            case 'listDownloads': {
                const downloads = sessionDownloads.get(sessionId) || [];
                const allFiles = fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR).map(f => {
                    const fp = path.join(DOWNLOADS_DIR, f);
                    return { name: f, path: fp, size: fs.statSync(fp).size };
                }) : [];
                sendEvent('tool', { tool: 'Download', message: `${downloads.length} session downloads, ${allFiles.length} total in folder` });
                return { success: true, output: { sessionDownloads: downloads, allFiles } };
            }
            case 'openDownload': {
                const filename = action.value || action.path;
                const filePath = path.join(DOWNLOADS_DIR, path.basename(filename));
                if (!fs.existsSync(filePath)) return { success: false, error: `Downloaded file not found: "${filename}"` };
                exec(`start "" "${filePath}"`, (err) => { if (err) console.error('Failed to open download:', err); });
                sendEvent('tool', { tool: 'Download', message: `Opened: ${path.basename(filename)}` });
                return { success: true, output: { opened: filePath } };
            }
            default:
                return { success: false, error: `Unknown download action: ${action.type}` };
        }
    } catch (err) {
        if (err.message && err.message.includes('Timeout')) {
            sendEvent('tool', { tool: 'Download', message: '\u23F1\uFE0F No download started within 15s' });
            return { success: false, error: 'Download timeout: no download started within 15 seconds' };
        }
        return { success: false, error: err.message };
    }
};

// --- UNIFIED TOOL ACTION DISPATCHER ---
const executeToolAction = async (toolName, action, page, context, sendEvent, memory, sessionId, browserState) => {
    sendEvent('tool', { tool: toolName, message: `Action: ${action.description || action.type}` });

    memory.toolMemory.recentlyUsedTools.push({
        tool: toolName, action: action.type,
        description: action.description || '',
        timestamp: new Date().toISOString()
    });
    if (memory.toolMemory.recentlyUsedTools.length > 10) {
        memory.toolMemory.recentlyUsedTools = memory.toolMemory.recentlyUsedTools.slice(-10);
    }

    let result;
    switch (toolName) {
        case 'browser': {
            if (action.type === 'switchTab') {
                const allPages = context.pages();
                const targetUrl = action.url;
                const targetIndex = parseInt(action.value || '0');
                let targetPage = targetUrl ? allPages.find(p => p.url().includes(targetUrl)) : null;
                if (!targetPage && targetIndex >= 0 && targetIndex < allPages.length) targetPage = allPages[targetIndex];
                if (targetPage) {
                    await targetPage.bringToFront();
                    browserState.activePage = targetPage;
                    sendEvent('tool', { tool: 'Browser', message: `Switched to tab: ${targetPage.url()}` });
                    result = { success: true, output: { switchedTo: targetPage.url() } };
                } else {
                    result = { success: false, error: 'Target tab not found' };
                }
                break;
            }
            if (action.type === 'closeTab') {
                const allPages = context.pages();
                const idx = parseInt(action.value || '0');
                if (idx >= 0 && idx < allPages.length) {
                    const closingUrl = allPages[idx].url();
                    await allPages[idx].close();
                    sendEvent('tool', { tool: 'Browser', message: `Closed tab: ${closingUrl}` });
                    result = { success: true, output: { closed: closingUrl } };
                } else {
                    result = { success: false, error: 'Tab index out of range' };
                }
                break;
            }
            if (action.type === 'openTab') {
                const newPage = await openOrReuseTab(context, browserState, action.url, sendEvent);
                result = { success: true, output: { opened: newPage.url() } };
                break;
            }
            result = await executeActionWithRecovery(page, action, sendEvent, browserState, context);
            break;
        }
        case 'file':
            result = await executeFileTool(action, sendEvent);
            break;
        case 'terminal':
            result = await executeTerminalTool(action, sendEvent);
            break;
        case 'download':
            result = await executeDownloadTool(action, page, sendEvent, sessionId);
            break;
        default:
            result = { success: false, error: `Unknown tool: ${toolName}` };
    }

    memory.toolMemory.toolOutputs[toolName] = {
        lastAction: action.type,
        lastResult: result.success ? 'success' : 'failed',
        lastOutput: result.output ? JSON.stringify(result.output).substring(0, 500) : (result.stdout || '').substring(0, 500),
        timestamp: new Date().toISOString()
    };

    if (!result.success) {
        memory.toolMemory.failedToolAttempts.push({
            tool: toolName, action: action.type,
            error: result.error || 'Unknown error',
            timestamp: new Date().toISOString()
        });
        if (memory.toolMemory.failedToolAttempts.length > 10) {
            memory.toolMemory.failedToolAttempts = memory.toolMemory.failedToolAttempts.slice(-10);
        }
    }

    return result;
};

const getDomainFromUrl = (url) => {
    try {
        if (!url || url === 'about:blank') return null;
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch (e) {
        return null;
    }
};

const updateAuthMemory = async (domain, context) => {
    try {
        const authMemoryPath = path.join(tempDir, 'auth_memory.json');
        let authMemory = {};
        if (fs.existsSync(authMemoryPath)) {
            try {
                authMemory = JSON.parse(fs.readFileSync(authMemoryPath, 'utf8'));
            } catch (e) {
                authMemory = {};
            }
        }
        
        let expiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // Default 24h
        if (context) {
            const cookies = await context.cookies();
            const expDates = cookies
                .map(c => c.expires)
                .filter(exp => exp && exp > 0 && exp < 2147483647);
            if (expDates.length > 0) {
                const minExp = Math.min(...expDates);
                expiration = new Date(minExp * 1000).toISOString();
            }
        }

        authMemory[domain] = {
            domain,
            status: 'active',
            lastLogin: new Date().toISOString(),
            sessionExpiration: expiration
        };
        
        fs.writeFileSync(authMemoryPath, JSON.stringify(authMemory, null, 2), 'utf8');
    } catch (e) {
        console.error("[System] Failed to update auth memory:", e);
    }
};

const saveBrowserSession = async (page, context, domain) => {
    if (!domain) return;
    try {
        const storage = await context.storageState();
        const sessionStorageData = await page.evaluate(() => {
            return JSON.stringify(window.sessionStorage);
        }).catch(() => null);
        
        storage.sessionStorage = sessionStorageData;
        
        const sessionPath = path.join(tempDir, `session_${domain}.json`);
        fs.writeFileSync(sessionPath, JSON.stringify(storage, null, 2), 'utf8');
        console.log(`[System] Browser session saved for domain: ${domain}`);
        
        await updateAuthMemory(domain, context);
    } catch (err) {
        console.error(`[System] Failed to save browser session for ${domain}:`, err);
    }
};

const getCredentials = (domain, reqBodyCredentials) => {
    if (!domain) return null;
    if (reqBodyCredentials && reqBodyCredentials[domain]) {
        return reqBodyCredentials[domain];
    }
    const envUserKey = `AUTH_${domain.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_USER`;
    const envPassKey = `AUTH_${domain.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASS`;
    if (process.env[envUserKey] && process.env[envPassKey]) {
        return {
            username: process.env[envUserKey],
            password: process.env[envPassKey]
        };
    }
    const credPath = path.join(tempDir, 'credentials.json');
    if (fs.existsSync(credPath)) {
        try {
            const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            if (creds[domain]) {
                return creds[domain];
            }
        } catch (e) {}
    }
    return null;
};

const analyzeVisualState = async (screenshotBase64, goal, state) => {
    if (!GROQ_API_KEY) {
        return { 
            blocksTask: false, 
            reasoning: 'No API key configured.', 
            recommendation: 'No vision API key configured.', 
            selfCorrection: {
                whatHappened: 'No Vision API key configured.',
                whyFailed: 'API key not found in environment.',
                recoveryActionSelected: 'None.',
                whyNewActionSucceeds: 'N/A'
            },
            action: null 
        };
    }

    try {
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `You are the visual recovery brain of Paradox AI. An automated browser task is running.
The current task goal: "${goal}"
Current URL: ${state.url}
Current title: "${state.title}"
Last action attempted: ${state.lastAction ? JSON.stringify(state.lastAction) : 'None'}
Last action outcome: ${state.lastOutcome ? JSON.stringify(state.lastOutcome) : 'None'}

Analyze the browser screenshot and current state. Determine:
1. What is preventing progress (popups, dialogs, cookie banners, login prompts, error messages, blocked UI)?
2. What element/selector should the agent interact with next to bypass this obstacle?
3. What type of action to take (e.g. click, type, pressKey, navigate)?

You must respond with a JSON object of this structure:
{
  "blocksTask": true | false,
  "reasoning": "What is preventing progress and explanation",
  "recommendation": "Short instruction on how to bypass",
  "selfCorrection": {
    "whatHappened": "Visual description of the popup, error, or obstacle",
    "whyFailed": "Why the last action was blocked or failed visually",
    "recoveryActionSelected": "Recommendation on how to bypass",
    "whyNewActionSucceeds": "Why this bypass action is expected to succeed"
  },
  "action": {
    "type": "click" | "type" | "pressKey" | "navigate" | "none",
    "selector": "CSS selector to interact with, if any",
    "value": "Value to type, if type",
    "key": "Key to press, if pressKey",
    "url": "URL to navigate, if navigate",
    "description": "Description of the recovery action"
  }
}
Respond ONLY with this JSON block, no surrounding explanations.`
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${screenshotBase64}`
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.1
            })
        });

        const data = await response.json();
        const rawText = data.choices[0].message.content.trim();
        const match = rawText.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonText = match ? match[1] : rawText;
        return JSON.parse(jsonText.trim());
    } catch (err) {
        console.error("Visual recovery analysis failed:", err);
        return {
            blocksTask: false,
            reasoning: `Visual analysis failed: ${err.message}`,
            recommendation: 'Fallback to DOM-first reasoning.',
            selfCorrection: {
                whatHappened: 'Visual analysis encountered an error.',
                whyFailed: err.message,
                recoveryActionSelected: 'Fallback to DOM-first reasoning.',
                whyNewActionSucceeds: 'Allows text-based models to proceed.'
            },
            action: null
        };
    }
};

const verifyProgress = async (prevPage, currentPage, action, outcome) => {
    // 1. Did the action itself fail?
    if (!outcome || !outcome.success) {
        return { progressed: false, reason: `Action execution failed: ${outcome ? outcome.error : 'Unknown error'}` };
    }
    
    // 2. Navigation action check
    if (action.type === 'navigate') {
        if (currentPage.url === prevPage.url) {
            return { progressed: false, reason: "Navigation target URL was not reached; URL did not change." };
        }
        return { progressed: true };
    }
    
    // 3. For click/pressKey actions:
    if (action.type === 'click' || action.type === 'pressKey') {
        const urlChanged = currentPage.url !== prevPage.url;
        const titleChanged = currentPage.title !== prevPage.title;
        
        // Compare elements list
        const prevElementsJson = JSON.stringify(prevPage.elements);
        const currentElementsJson = JSON.stringify(currentPage.elements);
        const elementsChanged = prevElementsJson !== currentElementsJson;
        
        // If nothing changed at all, we didn't progress
        if (!urlChanged && !titleChanged && !elementsChanged) {
            return { progressed: false, reason: "Page content remained completely static after the click/keypress." };
        }
    }
    
    // 4. For type actions:
    if (action.type === 'type') {
        // Find if target input exists and if it has the value (or is different from previous)
        const targetInput = currentPage.elements.inputs.find(inp => inp.selector === action.selector);
        if (targetInput) {
            const prevInput = prevPage.elements.inputs.find(inp => inp.selector === action.selector);
            // If the value is still the same as before, or is not populated:
            if (targetInput.value === (prevInput ? prevInput.value : '') && action.value.length > 0) {
                return { progressed: false, reason: `Value was not successfully entered into input field "${action.selector}".` };
            }
        }
    }
    
    return { progressed: true };
};

const getAccessibilityLocator = async (page, targetSelector, action) => {
    try {
        const details = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            return {
                role: el.getAttribute('role') || el.tagName.toLowerCase(),
                name: el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || '',
                label: el.getAttribute('aria-label') || '',
                placeholder: el.placeholder || '',
                text: el.innerText || ''
            };
        }, targetSelector);

        if (details) {
            // Try getting by role
            if (details.role && details.name) {
                let role = details.role.toLowerCase();
                if (role === 'a') role = 'link';
                if (role === 'input') role = 'textbox';
                
                const validRoles = ['button', 'checkbox', 'heading', 'link', 'textbox', 'searchbox', 'combobox', 'radio', 'tab'];
                if (validRoles.includes(role)) {
                    try {
                        const loc = page.getByRole(role, { name: details.name.trim(), exact: false }).first();
                        if (await loc.count() > 0) return loc;
                    } catch (e) {}
                }
            }

            // Try getting by label
            if (details.label) {
                try {
                    const loc = page.getByLabel(details.label).first();
                    if (await loc.count() > 0) return loc;
                } catch (e) {}
            }

            // Try getting by placeholder
            if (details.placeholder) {
                try {
                    const loc = page.getByPlaceholder(details.placeholder).first();
                    if (await loc.count() > 0) return loc;
                } catch (e) {}
            }

            // Try getting by text
            if (details.text && details.text.trim().length > 0) {
                try {
                    const loc = page.getByText(details.text.trim(), { exact: false }).first();
                    if (await loc.count() > 0) return loc;
                } catch (e) {}
            }
        }

        // Traversal of the accessibility snapshot as fallback if element is not in DOM
        if (action.description) {
            const snapshot = page.accessibility ? await page.accessibility.snapshot() : null;
            if (snapshot) {
                const nodes = [];
                const flatten = (node) => {
                    if (node) {
                        nodes.push(node);
                        if (node.children) node.children.forEach(flatten);
                    }
                };
                flatten(snapshot);

                const descLower = action.description.toLowerCase();
                const matchedNode = nodes.find(node => {
                    if (!node.name) return false;
                    const nameLower = node.name.toLowerCase();
                    return descLower.includes(nameLower) || nameLower.includes(descLower);
                });

                if (matchedNode) {
                    let role = matchedNode.role;
                    const validRoles = ['button', 'checkbox', 'heading', 'link', 'textbox', 'searchbox', 'combobox', 'radio', 'tab'];
                    if (validRoles.includes(role)) {
                        try {
                            const loc = page.getByRole(role, { name: matchedNode.name, exact: false }).first();
                            if (await loc.count() > 0) return loc;
                        } catch (e) {}
                    }
                }
            }
        }
    } catch (err) {
        console.error('[System] Error in getAccessibilityLocator:', err);
    }
    return null;
};
const executeActionWithRecovery = async (page, action, sendEvent, browserState, context) => {
    const result = await _executeActionWithRecoveryRaw(page, action, sendEvent);
    if (result && result.success && page && !page.isClosed()) {
        sendEvent('log', `[System] Action executed. Waiting for page to stabilize...`);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
    }
    return result;
};

const _executeActionWithRecoveryRaw = async (page, action, sendEvent) => {
    let lastError = null;
    sendEvent('log', `Executing action: ${action.description || action.type}`);

    // If it's navigate or pressKey
    if (action.type === 'navigate') {
        // Step 1: Retry action
        try {
            sendEvent('log', `[Recovery Step 1] Navigating to ${action.url}...`);
            await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 1] Navigation failed: ${err.message}`);
        }

        // Step 2: Wait for page stability
        try {
            sendEvent('log', `[Recovery Step 2] Waiting for page stability...`);
            await page.waitForTimeout(2000);
            await page.goto(action.url, { waitUntil: 'load', timeout: 30000 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 2] Stable navigation failed: ${err.message}`);
        }
        return { success: false, error: lastError.message };
    }

    if (action.type === 'pressKey') {
        // Step 1: Retry press key
        try {
            sendEvent('log', `[Recovery Step 1] Pressing key "${action.key}"...`);
            if (action.key === 'Enter') {
                const submitSuccess = await agenticSubmit(page);
                if (!submitSuccess) {
                    await page.keyboard.press('Enter');
                }
            } else {
                await page.keyboard.press(action.key);
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Now for action types: click, type
    const targetSelector = action.selector;

    if (action.type === 'click') {
        // STEP 1: Direct click
        try {
            sendEvent('log', `[Recovery Step 1] Attempting direct click on selector "${targetSelector}"...`);
            await page.locator(targetSelector).first().click({ timeout: 1500 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 1] Click failed: ${err.message}`);
        }

        // STEP 2: Forced click
        try {
            sendEvent('log', `[Recovery Step 2] Attempting forced click (bypassing pointer interception)...`);
            await page.locator(targetSelector).first().click({ force: true, timeout: 1500 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 2] Forced click failed: ${err.message}`);
        }

        // STEP 3: JS-based click
        try {
            sendEvent('log', `[Recovery Step 3] Attempting direct JavaScript click...`);
            const clicked = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.focus();
                    el.click();
                    return true;
                }
                return false;
            }, targetSelector);
            if (clicked) {
                return { success: true };
            }
            throw new Error('Element not found in DOM.');
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 3] JS click failed: ${err.message}`);
        }

        // STEP 4: Scroll and click
        try {
            sendEvent('log', `[Recovery Step 4] Scrolling element into view and clicking...`);
            const locator = page.locator(targetSelector).first();
            await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
            await locator.click({ force: true, timeout: 1500 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 4] Scroll & click failed: ${err.message}`);
        }

        // STEP 5: Self-healing click
        try {
            sendEvent('log', `[Recovery Step 5] Triggering self-healing alternative selector search...`);
            await agenticClick(page, targetSelector, action.description, sendEvent);
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 5] Self-healing click failed: ${err.message}`);
        }

        // STEP 6: Accessibility tree locator
        try {
            sendEvent('log', `[Recovery Step 6] Attempting accessibility tree locator matching...`);
            const accLocator = await getAccessibilityLocator(page, targetSelector, action);
            if (accLocator) {
                await accLocator.click({ timeout: 1500 });
                return { success: true };
            }
            throw new Error('No valid matching accessibility node found.');
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 6] Accessibility tree click failed: ${err.message}`);
        }

        // STEP 7: Keyboard navigation fallback
        try {
            sendEvent('log', `[Recovery Step 7] Attempting keyboard tab-navigation click fallback...`);
            await page.keyboard.press('Tab');
            await page.keyboard.press('Enter');
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 7] Keyboard click fallback failed: ${err.message}`);
        }
    }

    if (action.type === 'type') {
        // STEP 1: Direct type
        try {
            sendEvent('log', `[Recovery Step 1] Attempting direct type on selector "${targetSelector}"...`);
            await page.locator(targetSelector).first().fill('', { timeout: 1500 });
            await page.locator(targetSelector).first().pressSequentially(action.value, { delay: 30, timeout: 1500 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 1] Direct type failed: ${err.message}`);
        }

        // STEP 2: Wait and type
        try {
            sendEvent('log', `[Recovery Step 2] Waiting for page stability and retrying type...`);
            await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1000);
            await page.locator(targetSelector).first().fill('', { timeout: 1500 });
            await page.locator(targetSelector).first().pressSequentially(action.value, { delay: 30, timeout: 1500 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 2] Stable type failed: ${err.message}`);
        }

        // STEP 3: Scroll and type
        try {
            sendEvent('log', `[Recovery Step 3] Scrolling element into view and typing...`);
            const locator = page.locator(targetSelector).first();
            await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
            await locator.fill('', { timeout: 1500 });
            await locator.pressSequentially(action.value, { delay: 30, timeout: 1500 });
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 3] Scroll & type failed: ${err.message}`);
        }

        // STEP 4: JS-based value assignment
        try {
            sendEvent('log', `[Recovery Step 4] Attempting direct JavaScript value assignment...`);
            const typed = await page.evaluate(({ sel, val }) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.focus();
                    if (el.tagName.toLowerCase() !== 'div') {
                        el.value = val;
                    } else {
                        el.innerText = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }, { sel: targetSelector, val: action.value });
            if (typed) {
                await page.keyboard.press('Space');
                await page.keyboard.press('Backspace');
                return { success: true };
            }
            throw new Error('Element not found in DOM.');
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 4] JS type failed: ${err.message}`);
        }

        // STEP 5: Self-healing type
        try {
            sendEvent('log', `[Recovery Step 5] Triggering self-healing alternative selector search...`);
            await agenticType(page, targetSelector, action.value);
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 5] Self-healing type failed: ${err.message}`);
        }

        // STEP 6: Accessibility tree locator matching
        try {
            sendEvent('log', `[Recovery Step 6] Attempting accessibility tree locator matching...`);
            const accLocator = await getAccessibilityLocator(page, targetSelector, action);
            if (accLocator) {
                await accLocator.fill('', { timeout: 1500 });
                await accLocator.pressSequentially(action.value, { delay: 30, timeout: 1500 });
                return { success: true };
            }
            throw new Error('No valid matching accessibility node found.');
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 6] Accessibility tree type failed: ${err.message}`);
        }

        // STEP 7: Keyboard input fallback
        try {
            sendEvent('log', `[Recovery Step 7] Attempting keyboard tab-navigation input fallback...`);
            await page.keyboard.press('Tab');
            await page.keyboard.insertText(action.value);
            return { success: true };
        } catch (err) {
            lastError = err;
            sendEvent('log', `[Recovery Step 7] Keyboard input fallback failed: ${err.message}`);
        }
    }

    return { success: false, error: lastError ? lastError.message : 'Recovery strategies exhausted' };
};

app.post('/api/automation/run', async (req, res) => {
    const { command, headless } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

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
        sendEvent('error', 'GROQ_API_KEY is not configured. Observe-Think-Act-Repeat loop requires GROQ_API_KEY to run.');
        res.end();
        return;
    }

    let browser;
    let browserState;
    let observerState = { running: false, interrupted: false };
    const checkpoints = [];

    // --- GOAL & SESSION TRACKER (Phase 5 requirement 1 & 5) ---
    const sessionId = req.body.sessionId || getMemoryHash(command);
    let memory = loadMemoryFromDisk(sessionId);
    let isResumed = false;

    if (memory) {
        sendEvent('log', `[System] Interrupted session detected (Session ID: ${sessionId}). Restoring state...`);
        isResumed = true;
    } else {
        memory = createAgentMemory(command);
        saveMemoryToDisk(sessionId, memory);
    }

    try {
        sendEvent('log', '[System] GROQ_API_KEY detected. Launching fully autonomous step-by-step AI agent...');
        
        // Resolve initial URL using a simplified parser or restore from memory
        const plan = await getAutomationPlan(command);
        let startUrl = plan.url;

        if (isResumed && memory.task.currentUrl && memory.task.currentUrl !== 'about:blank') {
            startUrl = memory.task.currentUrl;
            sendEvent('log', `[System] Resuming from last known page URL: ${startUrl}`);
        }

        browserState = {
            activePage: null,
            pages: new Set(),
            taskState: {
                isExecutingAction: false,
                actionHistory: []
            }
        };

        const registerPage = (p) => {
            if (browserState.pages.has(p)) return;
            p._isAgentOwned = true;

            // Enforce MAX_TAB_LIMIT
            if (browserState.pages.size >= MAX_TAB_LIMIT) {
                let pageToClose = null;
                for (const page of browserState.pages) {
                    if (page !== browserState.activePage && !page.isClosed()) {
                        pageToClose = page;
                        break;
                    }
                }
                if (pageToClose) {
                    sendEvent('log', `[System] Max tab limit reached (${MAX_TAB_LIMIT}). Closing inactive tab: ${pageToClose.url()} to make room.`);
                    browserState.pages.delete(pageToClose);
                    pageToClose.close().catch(() => {});
                }
            }

            browserState.pages.add(p);
            browserState.activePage = p;
            
            p.on('dialog', async dialog => {
                const type = dialog.type();
                const msg = dialog.message();
                sendEvent('log', `[System] Dialog popup detected: "${msg}" (Type: ${type})`);
                if (['alert', 'confirm', 'prompt'].includes(type)) {
                    sendEvent('log', `[System] Automatically accepting dialog.`);
                    await dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
                } else {
                    await dialog.dismiss().catch(() => {});
                }
            });

            p.on('download', async download => {
                const filename = download.suggestedFilename();
                sendEvent('log', `[System] File download started: ${filename}`);
                sendEvent('tool', { tool: 'Download', message: `Download started: ${filename}` });
                if (!memory.context.downloadedFiles.includes(filename)) {
                    memory.context.downloadedFiles.push(filename);
                }
                try {
                    const savePath = path.join(DOWNLOADS_DIR, filename);
                    await download.saveAs(savePath);
                    sendEvent('tool', { tool: 'Download', message: `✅ Saved: ${filename} to downloads/` });
                    if (!sessionDownloads.has(sessionId)) sessionDownloads.set(sessionId, []);
                    sessionDownloads.get(sessionId).push({
                        filename, path: savePath, status: 'complete',
                        startTime: new Date().toISOString(),
                        size: fs.existsSync(savePath) ? fs.statSync(savePath).size : 0
                    });
                } catch (dlErr) {
                    sendEvent('log', `[Warning] Failed to save download: ${dlErr.message}`);
                }
                saveMemoryToDisk(sessionId, memory);
            });

            p.on('close', () => {
                browserState.pages.delete(p);
                if (browserState.activePage === p) {
                    browserState.activePage = Array.from(browserState.pages).pop() || null;
                    if (browserState.activePage) {
                        sendEvent('log', `[System] Active page closed. Switched active tab to: ${browserState.activePage.url()}`);
                    }
                }
            });
        };

        const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        const launchOptions = {
            headless: headless !== false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };

        if (fs.existsSync(EDGE_PATH)) {
            sendEvent('log', `Launching Microsoft Edge (${headless !== false ? 'headless' : 'headed'} mode) via Playwright...`);
            launchOptions.executablePath = EDGE_PATH;
        } else {
            sendEvent('log', `Microsoft Edge not found at ${EDGE_PATH}. Launching standard Chromium browser...`);
        }

        try {
            browser = await chromium.launch(launchOptions);
        } catch (launchErr) {
            sendEvent('log', `Failed to launch browser with custom executable. Attempting default Playwright launch...`);
            delete launchOptions.executablePath;
            browser = await chromium.launch(launchOptions);
        }

        const startDomain = getDomainFromUrl(startUrl);
        const contextOptions = {
            viewport: { width: 1280, height: 800 }
        };

        if (startDomain) {
            const sessionPath = path.join(tempDir, `session_${startDomain}.json`);
            if (fs.existsSync(sessionPath)) {
                try {
                    const sessionContent = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                    const sessionStorageData = sessionContent.sessionStorage;
                    delete sessionContent.sessionStorage;
                    
                    const tempSessionFile = path.join(tempDir, `temp_storage_${sessionId}.json`);
                    fs.writeFileSync(tempSessionFile, JSON.stringify(sessionContent), 'utf8');
                    contextOptions.storageState = tempSessionFile;
                    
                    sendEvent('log', `[System] Reusing saved browser session cookies & localStorage for ${startDomain}`);
                    contextOptions._sessionStorageData = sessionStorageData;
                    contextOptions._tempSessionFile = tempSessionFile;
                } catch (e) {
                    sendEvent('log', `[System] Failed to parse saved session for ${startDomain}: ${e.message}`);
                }
            }
        }

        const context = await browser.newContext(contextOptions);

        if (contextOptions._tempSessionFile && fs.existsSync(contextOptions._tempSessionFile)) {
            try { fs.unlinkSync(contextOptions._tempSessionFile); } catch (e) {}
        }

        context.on('page', newPage => {
            sendEvent('log', `[System] New tab/popup opened: ${newPage.url() || 'about:blank'}`);
            registerPage(newPage);
        });

        const initialPage = await context.newPage();
        registerPage(initialPage);

        // Register in activeSessions
        activeSessions.set(sessionId, {
            browser,
            context,
            getActivePage: () => browserState.activePage,
            observerState,
            sendEvent
        });
        
        // Start background observer loop
        observerState = { running: true, interrupted: false, sessionId: sessionId };
        startPageObserver(() => browserState.activePage, sendEvent, headless, observerState, browserState);
        
        sendEvent('log', `Navigating to ${startUrl}...`);
        try {
            await browserState.activePage.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (gotoErr) {
            sendEvent('log', `[Warning] Navigation status: ${gotoErr.message}. Checking page...`);
        }
        
        // Restore sessionStorage if loaded
        if (contextOptions._sessionStorageData) {
            try {
                await browserState.activePage.evaluate((data) => {
                    const sessionData = JSON.parse(data);
                    for (const key in sessionData) {
                        window.sessionStorage.setItem(key, sessionData[key]);
                    }
                }, contextOptions._sessionStorageData);
                sendEvent('log', `[System] Restored sessionStorage for ${startDomain}`);
            } catch (e) {
                sendEvent('log', `[Warning] Failed to restore sessionStorage: ${e.message}`);
            }
        }

        // Wait if currently interrupted (e.g. by Cloudflare during initial load)
        while (observerState.interrupted) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        sendEvent('log', `Page loaded.`);
        let screenshot = (await browserState.activePage.screenshot({ type: 'jpeg', quality: 80 })).toString('base64');
        sendEvent('screenshot', screenshot);

        const history = isResumed ? [...memory.progress.completedSteps] : [];
        const maxSteps = 20;
        let stepNum = isResumed ? memory.progress.completedSteps.length : 0;
        let lastAction = isResumed ? memory.task.lastAction : null;
        let lastOutcome = null;
        
        while (stepNum < maxSteps) {
            // Wait while interrupted
            while (observerState.interrupted) {
                sendEvent('log', '[System] Automation is paused. Waiting for interruption/CAPTCHA to be solved...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Dismiss popups/challenges first before observing state or querying LLM
            await handlePopupsAndChallenges(browserState.activePage, sendEvent);

            // 1. OBSERVE
            sendEvent('log', `[Step ${stepNum + 1}] Observing browser state...`);
            const state = await collectBrowserState(browserState.activePage, command, lastAction, lastOutcome);
            
            // Update Context Memory (Phase 5 requirement 4)
            memory.task.currentPage = state.title;
            memory.task.currentUrl = state.url;
            memory.task.lastAction = lastAction;
            
            if (!memory.context.pagesAlreadyVisited.includes(state.url)) {
                memory.context.pagesAlreadyVisited.push(state.url);
            }

            const allPages = context.pages();
            memory.context.openTabs = await Promise.all(allPages.map(async p => ({
                url: p.url(),
                title: await p.title().catch(() => 'Unknown Title')
            })));

            // Check if we should trigger visual recovery mode
            const visualTrigger = detectVisualTriggers(state, lastOutcome);
            let visualGuidance = null;
            let decision = null;
            let screenshotBase64 = null;
            
            // Update Internal Summary Obstacle (Phase 5 requirement 7)
            memory.internalSummary.goal = command;
            memory.internalSummary.currentProgress = `Completed ${memory.progress.completedSteps.length} steps. Last visited: "${state.title}"`;
            memory.internalSummary.currentObstacle = visualTrigger.triggered ? visualTrigger.reason : "None";
            memory.internalSummary.currentPlan = lastAction ? `Executed: ${lastAction.description || lastAction.type}` : "Navigating start URL.";

            saveMemoryToDisk(sessionId, memory);
            emitInternalSummary(memory, sendEvent);

            if (visualTrigger.triggered) {
                sendEvent('log', `[Visual Recovery Triggered] Reason: ${visualTrigger.reason}. Capturing screenshot...`);
                screenshotBase64 = (await browserState.activePage.screenshot({ type: 'jpeg', quality: 80 })).toString('base64');
                sendEvent('screenshot', screenshotBase64);
                
                // Get visual recovery analysis from the vision model
                visualGuidance = await analyzeVisualState(screenshotBase64, command, state);
                sendEvent('log', `[Visual Recovery Guidance] Reasoning: ${visualGuidance.reasoning} | Recommendation: ${visualGuidance.recommendation}`);
                
                // Emit Visual Recovery Self-Correction details if populated (Phase 4 requirement 6)
                if (visualGuidance.selfCorrection && visualGuidance.selfCorrection.whatHappened) {
                    sendEvent('log', `[Visual Self-Correction]
  - What Happened: ${visualGuidance.selfCorrection.whatHappened}
  - Why Failed: ${visualGuidance.selfCorrection.whyFailed}
  - Recovery Strategy Selected: ${visualGuidance.selfCorrection.recoveryActionSelected}
  - Bypassing Logic: ${visualGuidance.selfCorrection.whyNewActionSucceeds}`);
                }

                // If visual analyzer recommends a specific recovery action, override the decision
                if (visualGuidance.action && visualGuidance.action.type !== 'none') {
                    sendEvent('log', `[Visual Recovery Action] Overriding next action with recovery action: ${visualGuidance.action.description || visualGuidance.action.type}`);
                    decision = {
                        status: 'execute',
                        reasoning: `Visual recovery required: ${visualGuidance.reasoning}`,
                        confidence: 'High',
                        selfCorrection: visualGuidance.selfCorrection,
                        action: visualGuidance.action
                    };
                }
            }

            // 2. THINK
            if (!decision) {
                sendEvent('log', `[System] Querying Paradox AI brain using DOM-first reasoning...`);
                // Enforces Goal Awareness Check inside system prompt (Phase 5 requirement 6)
                decision = await getNextAgentAction(command, state.url, state.title, state.elements, state.accessibilityTree, history, visualGuidance, {
                    originalGoal: command,
                    currentStep: stepNum + 1,
                    completedSteps: memory.progress.completedSteps,
                    failedAttempts: memory.progress.failedSteps,
                    context: memory.context
                }, sendEvent);
            }
            
            if (!decision) {
                sendEvent('log', '[Error] Failed to get next action decision from AI brain. Ending execution.');
                break;
            }

            // If the agent is uncertain (Low confidence) and we haven't already captured visual recovery this step
            if (decision.status === 'execute' && decision.confidence === 'Low' && !visualTrigger.triggered) {
                sendEvent('log', `[Visual Recovery Triggered] Reason: Agent is uncertain (Confidence: Low). Capturing screenshot for visual analysis...`);
                screenshotBase64 = (await browserState.activePage.screenshot({ type: 'jpeg', quality: 80 })).toString('base64');
                sendEvent('screenshot', screenshotBase64);
                
                visualGuidance = await analyzeVisualState(screenshotBase64, command, state);
                sendEvent('log', `[Visual Recovery Guidance] Reasoning: ${visualGuidance.reasoning} | Recommendation: ${visualGuidance.recommendation}`);
                
                if (visualGuidance.selfCorrection && visualGuidance.selfCorrection.whatHappened) {
                    sendEvent('log', `[Visual Self-Correction]
  - What Happened: ${visualGuidance.selfCorrection.whatHappened}
  - Why Failed: ${visualGuidance.selfCorrection.whyFailed}
  - Recovery Strategy Selected: ${visualGuidance.selfCorrection.recoveryActionSelected}
  - Bypassing Logic: ${visualGuidance.selfCorrection.whyNewActionSucceeds}`);
                }

                if (visualGuidance.action && visualGuidance.action.type !== 'none') {
                    sendEvent('log', `[Visual Recovery Action] Overriding next action with recovery action: ${visualGuidance.action.description || visualGuidance.action.type}`);
                    decision = {
                        status: 'execute',
                        reasoning: `Visual recovery required: ${visualGuidance.reasoning}`,
                        confidence: 'High',
                        selfCorrection: visualGuidance.selfCorrection,
                        action: visualGuidance.action
                    };
                }
            }
            
            sendEvent('log', `[Agent Reasoning]
  - Thought: ${decision.reasoning}
  - Decision: ${decision.action ? (decision.action.description || decision.action.type) : 'None'}
  - Confidence: ${decision.confidence}`);

            // Emit Self-Correction details from standard reasoning if populated (Phase 4 requirement 6)
            if (decision.selfCorrection && decision.selfCorrection.whatHappened) {
                sendEvent('log', `[Self-Correction Log]
  - What Happened: ${decision.selfCorrection.whatHappened}
  - Why Failed: ${decision.selfCorrection.whyFailed}
  - Recovery Action Selected: ${decision.selfCorrection.recoveryActionSelected}
  - Why Action Will Succeed: ${decision.selfCorrection.whyNewActionSucceeds}`);
            }

            if (decision.status === 'complete') {
                sendEvent('log', `[Success] Paradox AI achieved final objective: ${decision.reasoning}`);
                memory.task.status = 'completed';
                memory.internalSummary.currentProgress = "Goal achieved: " + decision.reasoning;
                memory.internalSummary.currentPlan = "Task complete.";
                saveMemoryToDisk(sessionId, memory);
                emitInternalSummary(memory, sendEvent);
                break;
            }
            if (decision.status === 'failed') {
                sendEvent('log', `[Error] Paradox AI aborted: ${decision.reasoning}`);
                memory.task.status = 'failed';
                memory.internalSummary.currentProgress = "Task aborted: " + decision.reasoning;
                memory.internalSummary.currentPlan = "Task failed.";
                saveMemoryToDisk(sessionId, memory);
                emitInternalSummary(memory, sendEvent);
                break;
            }
            
            const action = decision.action;
            if (!action) {
                sendEvent('log', '[Warning] AI returned empty action step. Waiting...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }

            // Duplicate Action Audit check
            if (isDuplicateAction(action, browserState.taskState.actionHistory)) {
                sendEvent('log', `[Warning] Duplicate action detected within 15s window: "${action.description || action.type}". Rejecting duplicate action to force self-correction.`);
                lastOutcome = { success: false, error: `Duplicate action detected: "${action.description || action.type}" on target "${action.selector || action.url || action.key}". Loop prevention triggered.` };
                
                // Update failure memory
                memory.failures.failedActions.push(action);
                memory.progress.failedSteps.push({
                    action,
                    error: lastOutcome.error,
                    stepIndex: stepNum
                });
                memory.progress.retryCount++;
                
                stepNum++;
                await new Promise(resolve => setTimeout(resolve, 1500));
                continue;
            }

            // Record action in history
            browserState.taskState.actionHistory.push({
                type: action.type,
                selector: action.selector,
                value: action.value,
                key: action.key,
                url: action.url,
                timestamp: Date.now()
            });

            // Update Task Memory Next Intended Action (Phase 5 requirement 1)
            memory.task.nextIntendedAction = action;
            memory.internalSummary.currentPlan = action.description || action.type;
            saveMemoryToDisk(sessionId, memory);
            emitInternalSummary(memory, sendEvent);

            // 3. ACT
            browserState.taskState.isExecutingAction = true;
            try {
                lastAction = action;
                history.push(`${action.description || action.type} (URL: ${state.url})`);
                
                // Record Context Form Data / Search Queries
                if (action.type === 'type') {
                    memory.context.formDataEntered[action.selector] = action.value;
                    if (action.selector.includes('search') || action.selector.includes('q') || action.description.toLowerCase().includes('search')) {
                        if (!memory.context.searchQueriesUsed.includes(action.value)) {
                            memory.context.searchQueriesUsed.push(action.value);
                        }
                    }
                }

                // Execute the action with built-in recovery strategy via centralized dispatcher
                lastOutcome = await executeToolAction('browser', action, browserState.activePage, context, sendEvent, memory, sessionId, browserState);
            } finally {
                browserState.taskState.isExecutingAction = false;
            }

            // Brief wait for visual updates before progress verification
            await browserState.activePage.waitForTimeout(1000);

            // 4. VERIFY (Phase 4 progress verification & visual triggers)
            const postActionState = await collectBrowserState(browserState.activePage, command, action, lastOutcome);
            const progress = await verifyProgress(state, postActionState, action, lastOutcome);

            if (progress.progressed) {
                sendEvent('log', `[Verification] Action "${action.description || action.type}" verified successfully.`);
                memory.progress.completedSteps.push(`${action.description || action.type} (URL: ${postActionState.url})`);
                memory.task.lastAction = action;
                
                // Save valid browser session storage state (Phase 6 requirement 2)
                const currentDomain = getDomainFromUrl(browserState.activePage.url());
                if (currentDomain) {
                    await saveBrowserSession(browserState.activePage, context, currentDomain);
                }

                // Save recovery checkpoint after successful step
                const checkpointTitle = await browserState.activePage.title().catch(() => 'Unknown Page');
                checkpoints.push({
                    stepIndex: stepNum,
                    url: browserState.activePage.url(),
                    title: checkpointTitle
                });
            } else {
                sendEvent('log', `[Verification Failed] Progress check failed: ${progress.reason}`);
                
                // Update Failure Memory (Phase 5 requirement 3)
                if (action.selector && !memory.failures.failedSelectors.includes(action.selector)) {
                    memory.failures.failedSelectors.push(action.selector);
                }
                memory.failures.failedActions.push(action);
                
                memory.progress.failedSteps.push({
                    action,
                    error: progress.reason,
                    stepIndex: stepNum
                });
                
                memory.progress.retryCount++;
                
                // Force triggering high-level recovery / replanning on next step
                lastOutcome = { success: false, error: progress.reason };
            }
            
            stepNum++;
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Send screenshot to UI at the end of the step (only if not triggered during recovery, otherwise send standard)
            if (!visualTrigger.triggered && lastOutcome.success !== false) {
                const stepScreenshot = (await browserState.activePage.screenshot({ type: 'jpeg', quality: 80 })).toString('base64');
                sendEvent('screenshot', stepScreenshot);
            }
        }

        sendEvent('log', 'Finished automation task.');
        sendEvent('complete', 'Success');
    } catch (err) {
        console.error("Automation error:", err);
        sendEvent('log', `[Error] ${err.message}`);
        sendEvent('error', err.message);
    } finally {
        activeSessions.delete(sessionId);
        observerState.running = false;
        if (browser) {
            if (headless !== false) {
                if (!res.writableEnded) {
                    sendEvent('log', 'Closing background browser...');
                }
                await browser.close().catch(() => {});
            } else {
                if (!res.writableEnded) {
                    sendEvent('log', 'Automation complete. Browser left open for user interaction.');
                }
            }
        }
        if (!res.writableEnded) {
            res.end();
        }
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
    const { sessionId, action } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: "sessionId is required" });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: "Active session not found" });
    }

    try {
        const page = session.getActivePage();
        if (!page || page.isClosed()) {
            return res.status(400).json({ error: "Page is closed or unavailable" });
        }

        if (action) {
            if (action.type === 'type') {
                let targetSelector = action.selector;
                if (!targetSelector || targetSelector === 'input') {
                    targetSelector = await page.evaluate(() => {
                        const selectors = [
                            'input[id*="otp" i]', 'input[name*="otp" i]', 'input[class*="otp" i]',
                            'input[id*="code" i]', 'input[name*="code" i]', 'input[placeholder*="code" i]', 'input[placeholder*="verification" i]',
                            'input[type="text"]', 'input[type="number"]', 'input[type="password"]', 'input'
                        ];
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el) {
                                const rect = el.getBoundingClientRect();
                                const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
                                if (isVisible) {
                                    let s = el.tagName.toLowerCase();
                                    if (el.id) s += `#${el.id}`;
                                    else if (el.name) s += `[name="${el.name}"]`;
                                    return s;
                                }
                            }
                        }
                        return 'input';
                    });
                }
                session.sendEvent('log', `[Human Action] Typing value into inferred selector "${targetSelector}"`);
                await page.locator(targetSelector).first().fill('', { timeout: 3000 }).catch(() => {});
                await page.locator(targetSelector).first().pressSequentially(action.value, { delay: 30, timeout: 5000 });
            } else if (action.type === 'click') {
                session.sendEvent('log', `[Human Action] Clicking selector "${action.selector}"`);
                await page.locator(action.selector).first().click({ timeout: 5000 });
            }
        }

        // Force clearing the pause state
        session.observerState.loginPrompted = false;
        session.observerState.interrupted = false;
        
        session.sendEvent('log', '[System] Human action processed. Resuming automation loop...');
        session.sendEvent('resume', { sessionId });

        res.json({ success: true });
    } catch (err) {
        console.error("Failed to execute human action:", err);
        res.status(500).json({ error: err.message });
    }
});

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

// Serve ggg.html as the index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ggg.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
