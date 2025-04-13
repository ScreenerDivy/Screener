const puppeteer = require('puppeteer');
const fs = require('fs');
const { YoutubeTranscript } = require('youtube-transcript');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const path = require('path');

// Configuration
const CONFIG = {
  groqApiKey: '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', // Replace with actual API key
  credentials: {
    email: 'your_email@example.com',
    password: 'your_password'
  },
  maxContentLength: 12000,
  retryCount: 3,
  retryDelay: 2000,
  wordpressSiteUrl: 'https://your-wordpress-site.com/wp-json/stock-analysis/v1/screener' // URL to store data in WordPress site
};

// Path setup
const OUTPUT_DIR = path.join(__dirname, 'final_output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Date helpers
function getFormattedYesterday() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).replace(/ /g, ' ');
}

// Text processing
function sanitizeFilename(name) {
  return name
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .substring(0, 50)
    .trim();
}

async function processWithGroq(companyName, content) {
  const processedFile = path.join(__dirname, 'processed.json');
  const processedData = fs.existsSync(processedFile) ? JSON.parse(fs.readFileSync(processedFile)) : [];
  if (processedData.includes(companyName)) {
    console.log(`Company ${companyName} already processed.`);
    return;
  }
  const truncatedContent = content.substring(0, CONFIG.maxContentLength);
  const prompt = `Analyze the financial transcript and extract:
1. NSE symbol (string)
2. Revenue Growth (percentage string)
3. Profit Growth (percentage string)
4. EARNINGS REPORT DATE (DD-MM-YYYY)
5. Future growth opportunities (5 bullet points)
6. Key risks (5 bullet points)

Return valid JSON format. Transcript: ${truncatedContent}`;

  for (let attempt = 1; attempt <= CONFIG.retryCount; attempt++) {
    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'deepseek-r1-distill-llama-70b',
          messages: [{
            role: "user",
            content: prompt
          }],
          temperature: 0.1,
          response_format: { type: "json_object" }
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.groqApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const resultFile = await processGroqResponse(companyName, response.data);
      processedData.push(companyName); // Add company name to processedData after successful processing
      fs.writeFileSync(processedFile, JSON.stringify(processedData));
      return resultFile;
    } catch (error) {
      if (attempt === CONFIG.retryCount) throw error;
      await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * attempt));
    }
  }
}

async function processGroqResponse(companyName, groqResponse) {
    try {
        // Extract the JSON content from the response
        const content = JSON.parse(groqResponse.choices[0].message.content);
        
        // Create formatted text
        const formattedText = `
Company Analysis Report: ${companyName}
========================================

NSE Symbol: ${content["NSE symbol"] || 'N/A'}
Revenue Growth: ${content["Revenue Growth"] || 'N/A'}
Profit Growth: ${content["Profit Growth"] || 'N/A'}
Earnings Report Date: ${content["EARNINGS REPORT DATE"] || 'N/A'}

Future Growth Opportunities:
---------------------------
${content["Future growth opportunities"]?.map(point => `• ${point}`).join('\n') || 'No opportunities listed'}

Key Risks:
----------
${content["Key risks"]?.map(point => `• ${point}`).join('\n') || 'No risks listed'}
`;

        // Create filename
        const sanitizedName = sanitizeFilename(companyName);
        const filename = path.join(OUTPUT_DIR, `${sanitizedName}_analysis_${Date.now()}.txt`);
        
        // Write to file
        fs.writeFileSync(filename, formattedText);
        console.log(`Formatted analysis saved: ${filename}`);
        
        // Send data to WordPress site
        const dataToSend = {
          companyName: companyName,
          nseSymbol: content["NSE symbol"] || 'N/A',
          revenueGrowth: content["Revenue Growth"] || 'N/A',
          profitGrowth: content["Profit Growth"] || 'N/A',
          earningsReportDate: content["EARNINGS REPORT DATE"] || 'N/A',
          futureGrowthOpportunities: content["Future growth opportunities"]?.map(point => `• ${point}`).join('\n') || 'No opportunities listed',
          keyRisks: content["Key risks"]?.map(point => `• ${point}`).join('\n') || 'No risks listed'
        };
        await axios.post(CONFIG.wordpressSiteUrl, dataToSend, {
          headers: {
            'Content-Type': 'application/json'
          }
        });
        console.log(`Data sent to WordPress site for ${companyName}`);
        
        return filename;
    } catch (error) {
        console.error(`Error processing Groq response for ${companyName}: ${error.message}`);
        return null;
    }
}


async function processTranscript(entry, content) {
  try {
    const resultFile = await processWithGroq(entry.companyName, content);
    console.log(`Analysis saved: ${resultFile}`);
  } catch (error) {
    console.error(`Groq processing failed for ${entry.companyName}: ${error.message}`);
  }
}

async function processYouTube(entry) {
  try {
    const videoId = entry.link.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)[1];
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    const content = transcript.map(t => t.text).join('\n');
    await processTranscript(entry, content);
  } catch (error) {
    console.error(`YouTube processing failed for ${entry.companyName}: ${error.message}`);
  }
}

async function processPDF(entry) {
  try {
    const response = await axios.get(entry.link, { responseType: 'arraybuffer' });
    const data = await pdfParse(response.data);
    await processTranscript(entry, data.text);
  } catch (error) {
    console.error(`PDF processing failed for ${entry.companyName}: ${error.message}`);
  }
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    // Login process
    await page.goto('https://www.screener.in/login/?next=/concalls/', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.type('#id_username', CONFIG.credentials.email);
    await page.type('#id_password', CONFIG.credentials.password);
    
    const csrfToken = await page.$eval(
      'input[name="csrfmiddlewaretoken"]',
      el => el.value
    );

    await Promise.all([
      page.waitForNavigation(),
      page.click('button.button-primary')
    ]);

    // Data collection
    const targetDate = getFormattedYesterday();
    console.log(`Scraping data for date: ${targetDate}`);

    const entries = await page.$$eval('.field-action_display', (elements, targetDate) => {
      return elements.map(el => {
        const row = el.closest('tr');
        return {
          companyName: row.querySelector('.field-company_display span').innerText.trim(),
          link: el.querySelector('a').href,
          date: row.querySelector('.field-pub_date').innerText.trim()
        };
      }).filter(entry => entry.date === targetDate);
    }, targetDate);

    console.log(`Found ${entries.length} entries for ${targetDate}`);

    // Process entries
    for (const entry of entries) {
      console.log(`Processing ${entry.companyName}`);
      if (entry.link.includes('youtu.be') || entry.link.includes('youtube.com')) {
        await processYouTube(entry);
      } else if (entry.link.includes('.pdf')) {
        await processPDF(entry);
      }
      await new Promise(resolve => setTimeout(resolve, 1500)); // Rate limiting
    }

  } catch (error) {
    console.error(`Main process error: ${error.message}`);
  } finally {
    await browser.close();
    console.log('Process completed');
  }
})()