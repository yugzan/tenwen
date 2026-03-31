const Tesseract = require('tesseract.js');
const fs = require('fs');

async function run() {
  console.log('Starting OCR on 0.jpg');
  try {
    const { data: { text } } = await Tesseract.recognize(
      'c:/workspace/tenwen/imgs/0.jpg',
      'chi_sim',
      { logger: m => console.log(m.status, m.progress) }
    );
    console.log('============= OCR RESULT =============');
    console.log(text);
    console.log('======================================');
  } catch(e) {
    console.error(e);
  }
}

run();
