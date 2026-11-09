// The README quickstart as a script: upload a file, wait, print the transcript and the first SRT cue.
//   SCRIPTIVOX_API_KEY=sk_live_... node examples/quickstart.mjs [path-to-audio]
// (from a checkout, after `npm run build`; in your own project: import Scriptivox from 'scriptivox')
import Scriptivox from '../dist/esm/index.js';

const file = process.argv[2] ?? new URL('../test/fixtures/speech-en.mp3', import.meta.url);
const client = new Scriptivox();

const job = await client.transcribe({ file, language: 'en' }, { onUploadProgress: (p) => process.stdout.write(`\ruploading ${p.percent}%`) });
console.log(`\njob ${job.id} ${job.status}`);
const done = await client.wait(job.id, { onPoll: (t) => console.log(`  ${t.status}`) });
console.log(`\n${done.result.full_transcript}\n`);
const srt = await client.get(job.id, { format: 'srt' });
console.log(srt.split('\n\n')[0]);
