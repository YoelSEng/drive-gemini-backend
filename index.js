// index.js

// --- Section 1: Importing our tools ---
const express = require('express');
const { google } = require('googleapis');
const { VertexAI } = require('@google-cloud/vertexai');
const mammoth = require("mammoth");
const pdf = require('pdf-parse');
const pptx2json = require('pptx2json');
require('dotenv').config();



// This tells the Google library how to authenticate.
// --- Section 2: Initializing the Server and APIs ---
// --- Section 2: Initializing the Server and APIs ---
const app = express();
app.use(express.json());

// Check if credentials are in an environment variable (for Render) or a local file
const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) // If on Render, parse the variable
    : require('./credentials.json');                   // If local, require the file

// Create a single authentication object for all Google services
const auth = new google.auth.GoogleAuth({
    credentials, // Use the credentials object (either from variable or file)
    scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/cloud-platform'
    ],
});

// Use the auth object for Google Drive
const drive = google.drive({ version: 'v3', auth });

// Use the SAME auth object for Vertex AI
const vertexAI = new VertexAI({
    project: 'drive-gemini-site', // Your project ID
    location: 'us-central1',
    googleAuthOptions: { authClient: auth }
});

const generativeModel = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' }); // Or your preferred model

// --- Section 3: Creating our API Endpoints (The "Kitchen Orders") ---

// Endpoint #1: For the ROOT folder
app.get('/api/files', async (req, res) => {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    try {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType)',
            orderBy: 'folder, name',
        });
        res.json(response.data.files);
    } catch (error) {
        console.error('Error fetching root files from Drive:', error);
        res.status(500).json({ error: 'Failed to fetch files.' });
    }
});

// Endpoint #2: For any SUBFOLDER
app.get('/api/files/:folderId', async (req, res) => {
    const { folderId } = req.params;
    try {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType)',
            orderBy: 'folder, name',
        });
        res.json(response.data.files);
    } catch (error) {
        console.error(`Error fetching files for folder ${folderId}:`, error);
        res.status(500).json({ error: 'Failed to fetch files.' });
    }
});

// This endpoint handles the consultation with Gemini.
app.post('/api/consult', async (req, res) => {
    const { folderId, question } = req.body;
    if (!folderId || !question) {
        return res.status(400).json({ error: 'folderId and question are required.' });
    }

    try {
        // Step 1: Define all supported file types.
        const supportedMimeTypes = [
            "mimeType='text/plain'",
            "mimeType='application/vnd.google-apps.document'", // Google Doc
            "mimeType='application/pdf'", // PDF
            "mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document'", // .docx
            "mimeType='application/vnd.openxmlformats-officedocument.presentationml.presentation'", // .pptx
            "mimeType='application/msword'" // .doc
        ];

        const filesResponse = await drive.files.list({
            q: `'${folderId}' in parents and (${supportedMimeTypes.join(' or ')}) and trashed = false`,
            fields: 'files(id, name, mimeType)',
        });

        if (!filesResponse.data.files || filesResponse.data.files.length === 0) {
            return res.json({ answer: "I couldn't find any supported files (Docs, PDF, DOCX, PPTX, or text) in that folder to read." });
        }

        // Step 2: Loop through each file and use the correct parser.
        let context = '';
        for (const file of filesResponse.data.files) {
            console.log(`Processing file: ${file.name} (Type: ${file.mimeType})`);
            let fileContent = '';

            try {
                // For Google Docs, use the special 'export' method.
                if (file.mimeType === 'application/vnd.google-apps.document') {
                    const exportResponse = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' });
                    fileContent = exportResponse.data;
                } else {
                    // For all other file types, download the raw binary data.
                    const fileDataResponse = await drive.files.get(
                        { fileId: file.id, alt: 'media' },
                        { responseType: 'arraybuffer' }
                    );
                    const fileBuffer = Buffer.from(fileDataResponse.data);

                    // Use the correct parser based on the file's MIME type.
                    switch (file.mimeType) {
                        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': // .docx
                            const mammothResult = await mammoth.extractRawText({ buffer: fileBuffer });
                            fileContent = mammothResult.value;
                            break;

                        case 'application/pdf': // .pdf
                            const pdfData = await pdf(fileBuffer);
                            fileContent = pdfData.text;
                            break;

                        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': // .pptx
                            const pptxJson = await pptx2json.parse(fileBuffer);
                            fileContent = pptxJson.slides.map(slide => slide.text.raw).join('\n');
                            break;

                        case 'application/msword': // .doc
                            console.log(`Skipping unsupported .doc file: ${file.name}`);
                            fileContent = '';
                            break;

                        case 'text/plain': // Plain text
                            fileContent = fileBuffer.toString('utf8');
                            break;
                    }
                }
                // Add the parsed content to our overall context string for Gemini.
                context += `--- Content from file: ${file.name} ---\n${fileContent}\n\n`;
            } catch (parseError) {
                // If one file fails, log the error and continue to the next one.
                console.error(`Could not parse file ${file.name}:`, parseError.message);
                context += `--- Could not read content from file: ${file.name} ---\n\n`;
            }
        }

        // Step 3: Construct the prompt for Gemini.
        const prompt = `Based on the following documents, please answer the user's question. If you cannot find the answer, say so.
        User Question: "${question}"
        Documents:
        ${context}`;

        // Step 4: Call Gemini and get the response.
        const result = await generativeModel.generateContent(prompt);
        const response = result.response;
        // Check if Gemini actually returned a candidate response
        if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content) {
            const answer = response.candidates[0].content.parts[0].text;
            res.json({ answer });
        } else {
            // Handle cases where Gemini might not respond as expected (e.g., safety blocks)
            throw new Error('Gemini did not return a valid response.');
        }

    } catch (error) {
        console.error('Error with Gemini consultation:', error);
        res.status(500).json({ error: 'Failed to consult Gemini.' });
    }
});


// --- Section 4: Starting the Server ---
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Root folder ID: ${process.env.GOOGLE_DRIVE_FOLDER_ID}`);
});