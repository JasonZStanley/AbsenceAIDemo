const express = require('express')
const app = express()
const sqlite3 = require("sqlite3").verbose();
const dbpath = "./data.db";
const fs = require('fs');
const multer  = require('multer')
const upload = multer({ dest: 'public/storage/audio' })
const { exec } = require("child_process");
const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
    apiKey: '',
});
  
const openai = new OpenAIApi(configuration);

app.use(express.static('public'))

function createDbConnection() {
    let init = false;
    if (!fs.existsSync(dbpath)) {
        init = true;
    }

    const db = new sqlite3.Database(dbpath, (error) => {
        if (error) {
            return console.error(error.message);
        }
    });

    console.log("Connection with SQLite has been established");
    
    if (init) {
        console.log("Seeding the database...");
        db.run(`
            CREATE TABLE clips
            (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                audio   VARCHAR(200) NOT NULL,
                status   VARCHAR(200) NOT NULL,
                transcription_base TEXT NULL,
                transcription_base_time VARCHAR(200) NULL,
                transcription_small TEXT NULL,
                transcription_small_time VARCHAR(200) NULL,
                is_valid INTEGER(1) NULL,
                resolution TEXT NULL
            );
        `);
        console.log("Seeded.");
    }
    
    return db;
}


app.post('/store', upload.single('audio'), async function (req, res) {
    const db = createDbConnection();
    let id = 0;

    await db.run('INSERT INTO `clips` (`audio`, `status`) VALUES (?, ?)', [req.file.filename, 'waiting_base_transcribe'], async function (err) {
        if (err) {
            return console.log(err.message);
        }

        id = this.lastID;

        res.send({id: id})

        runWhisper(id, req.file.filename, 'base', async (data, time) => {
            const db = createDbConnection();
            db.run('UPDATE `clips` SET transcription_base=?, transcription_base_time=?, status=? WHERE id=?', [data, time, 'waiting_small_transcribe', id], function (err) {
                console.log("Stored base transcription");
            });

            runWhisper(id, req.file.filename, 'small', async (data, time) => {
                db.run('UPDATE `clips` SET transcription_small=?, transcription_small_time=?, status=? WHERE id=?', [data, time, 'waiting_ai_parse', id], function (err) {
                    console.log("Stored small transcription");
                });

                const aiparse = await openai.createCompletion({
                    model: "text-davinci-003",
                    max_tokens: 300,
                    prompt: `Hello, I'm phoning today to say that my son Zachary is feeling unwell and won't be attending school today.
        
                    What is the name of the child? (Child Name:)
                    What is the reason they won't be attending school? (Reason:)
                    Length of absence? (AM, PM, All Day:)
                    `,
                });

                const txt = aiparse.data.choices[0].text;
                const tokens = aiparse.data.usage.total_tokens;

                const resolution = {
                    ai_response: txt,
                    token_cost: tokens,
                    cost: (0.02/1000) * tokens
                }

                db.run('UPDATE `clips` SET resolution=?, status=? WHERE id=?', [JSON.stringify(resolution), 'done', id], function (err) {
                    console.log("Stored ai log");
                });
        
                console.log(tokens);
            });
        })
    });
});

app.get('/debug/:id', async function(req, res) {
    const db = createDbConnection();
    await db.all('SELECT * FROM `clips` WHERE id=?', [req.params.id], function (err, rows) {
        if (err) {
            return console.log(err.message);
        }

        res.send(rows[0]);
    });
});

app.get('/status/:id', async function(req, res) {
    const db = createDbConnection();
    await db.all('SELECT * FROM `clips` WHERE id=?', [req.params.id], function (err, rows) {
        if (err) {
            return console.log(err.message);
        }

        res.send({
            status: rows[0].status,
            audioFile: '/storage/audio/' + rows[0].audio,
            ai_parse: {
                childName: JSON.parse(rows[0].resolution).ai_response.split('\n')[1].replace('Child Name: ', ''),
                reasonForAbsence: JSON.parse(rows[0].resolution).ai_response.split('\n')[2].replace('Reason: ', ''),
                lengthOfAbsence: JSON.parse(rows[0].resolution).ai_response.split('\n')[3].replace('Length of Absence: ', ''),
                cost: {
                    tokens: JSON.parse(rows[0].resolution).token_cost,
                    actualCents: JSON.parse(rows[0].resolution).cost
                }
            },
            transcriptions: {
                small: {
                    data: rows[0].transcription_small,
                    seconds: rows[0].transcription_base_small,
                    info: "Thw Whisper AI small model provides a good balance between speed an accuracy"
                },
                base: {
                    data: rows[0].transcription_base,
                    seconds: rows[0].transcription_base_time,
                    info: "Thw Whisper AI base model is one the fastest models but can compromise on accuracy"
                }
            }
        })
    });
});

// OpenAI query
function runWhisper(id, file, model, callback) {
    var start = getSeconds();
    var child = exec('cd whisper && whisper ../public/storage/audio/' + file + ' --model '+model+' --language English --fp16 False')

    child.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });

    child.on('close', function() {
        fs.readFile('./whisper/'+file+'.txt', 'utf8', (err, data) => {
            data = data.replace('\n', ' ');

            callback(data, getSeconds() - start);

            fs.unlinkSync('whisper/'+file+'.srt')
            fs.unlinkSync('whisper/'+file+'.txt')
            fs.unlinkSync('whisper/'+file+'.vtt')
        });
    });
}

function getSeconds() {
    return new Date().getTime() / 1000;
}

app.listen(3000)