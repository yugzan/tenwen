const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// Basic Levenshtein distance
function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

async function start() {
    let opencc;
    try {
        const OpenCC = require('opencc-js');
        opencc = OpenCC.Converter({ from: 'cn', to: 'tw' });
    } catch (e) {
        console.log("Please install opencc-js: npm install opencc-js");
        process.exit(1);
    }
    
    // Load Truth
    const truthData = [];
    for (const id of [1, 2, 3, 4]) {
        const fileContent = fs.readFileSync(path.join(__dirname, `bili_truth_${id}.csv`), 'utf-8');
        const records = parse(fileContent, {
            columns: true,
            skip_empty_lines: true
        });
        for (const row of records) {
            truthData.push({
                question: opencc(row['题目']).trim(),
                answer: opencc(row['答案']).trim(),
                original_q: row['题目'].trim()
            });
        }
    }
    console.log(`Loaded ${truthData.length} authoritative Q&A from Bilibili.`);

    // Load Existing ten_backup.csv
    const tenContent = fs.readFileSync(path.join(__dirname, 'ten_backup.csv'), 'utf-8');
    const tenRecords = parse(tenContent, {
        columns: false,
        skip_empty_lines: true
    });
    
    let startIndex = 0;
    if (tenRecords[0] && tenRecords[0][0] && (tenRecords[0][0] === 'question')) {
        startIndex = 1;
    }

    const modifiedData = [];
    modifiedData.push(['question', 'answer']);

    let updatedCount = 0;
    let newItemsAdded = 0;
    let removedCount = 0;

    const truthUsed = new Array(truthData.length).fill(false);

    for (let i = startIndex; i < tenRecords.length; i++) {
        const row = tenRecords[i];
        if (row.length < 2) continue;

        let question = row[0].trim();
        let answer = row[1] ? row[1].trim() : '';
        
        // clean question from prefix
        let cleanQ = question.replace(/^(遊戲|劇情|詩詞)\s*[|｜]?\s*/, '').trim();

        // remove all non-alphanumeric/Chinese for pure comparison
        let baseCleanQ = cleanQ.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

        let isBad = answer === '' || answer === '...' || answer === '。。。';
        
        let matchedTruth = null;
        let matchIndex = -1;
        let minDistance = 9999;

        for (let j = 0; j < truthData.length; j++) {
            const t = truthData[j];
            let tBase = t.question.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
            let tOriginalBase = opencc(t.original_q).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
            
            const dist = levenshteinDistance(baseCleanQ, tBase);
            const distSimp = levenshteinDistance(baseCleanQ, tOriginalBase);
            const actDist = Math.min(dist, distSimp);

            if (actDist < minDistance) {
                minDistance = actDist;
                matchIndex = j;
            }
        }

        // Only match if they differ by AT MOST 1 character (to catch typos but preserve different semantic words)
        // Since the user said "保留类似也没关系" (ok to keep similar ones), it is better to have duplicates than overwrite valid ones!
        if (minDistance <= 1) {
             matchedTruth = truthData[matchIndex];
             truthUsed[matchIndex] = true;
             
             if (answer !== matchedTruth.answer) {
                 answer = matchedTruth.answer;
                 question = matchedTruth.question; // Replace with clean truth question
                 updatedCount++;
             } else {
                 // Even if answer matches, if we stripped noisy prefixes, we can use the clean question
                 question = matchedTruth.question; 
             }
             isBad = false;
        }

        if (isBad || answer === '') {
            removedCount++;
            continue;
        }

        modifiedData.push([opencc(question), opencc(answer)]);
    }

    for (let j = 0; j < truthData.length; j++) {
        if (!truthUsed[j]) {
            modifiedData.push([truthData[j].question, truthData[j].answer]);
            newItemsAdded++;
        }
    }

    const outputString = stringify(modifiedData, { header: false });
    fs.writeFileSync(path.join(__dirname, 'ten.csv'), outputString, 'utf-8');

    console.log(`Merge complete.`);
    console.log(`Original ten.csv rows processed: ${tenRecords.length - startIndex}`);
    console.log(`Items updated with correct truth answer: ${updatedCount}`);
    console.log(`Items removed (bad/empty answers): ${removedCount}`);
    console.log(`New items added from Bilibili truth: ${newItemsAdded}`);
    console.log(`Total rows in new ten.csv: ${modifiedData.length - 1} (excluding header)`);
}

start();
