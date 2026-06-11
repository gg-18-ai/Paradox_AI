require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.post('/api/chat', async (req, res) => {
    try {
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

// Serve ggg.html as the index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ggg.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
