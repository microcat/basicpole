import bodyParser from "body-parser";
import express from "express";
import {Application, Request, Response} from "express";
import {WebClient} from "@slack/client";

import {parsePollText, pollContentToBlocks} from "./helpers";
import * as storage from "./storage";
import {Mutex} from "./mutex";
import {verifier} from "./verify";
import {OAUTH_TOKEN, SIGNING_SECRET} from "./config";

async function main(): Promise<void> {
    const app: Application = express();
    const port: number = +(process.env.PORT || 8001);
    const db: storage.Storage = await storage.createStorage(process.env.DB || ':memory:');
    const slackClient = new WebClient(OAUTH_TOKEN);
    const postMutex: Mutex = new Mutex();

    // for parsing application/x-www-form-urlencoded - sent to slash commands/button clicks
    app.use(bodyParser.urlencoded({
        extended: true,
        verify: verifier(SIGNING_SECRET),
    }));

    app.get('/', (req: Request, res: Response) => res.send('Hello World!'))

    app.post('/create', async (req: Request, res: Response) => {
        // req has: channel_id, user_id, text (full command text)
        console.log(req.body);

        const parsedText = parsePollText(req.body.text);
        if (parsedText === undefined) {
            res.send("Sorry, your syntax wasn't understood.");
            return;
        }
        const {content, options} = parsedText;

        const channel_id = req.body.channel_id;

        try {
            const slackMsgRes: any = await slackClient.chat.postMessage({
                channel: channel_id,
                text: '',
                blocks: pollContentToBlocks({
                    content: content,
                    options: options,
                })
            });
            await db.createPoll({
                channel_id: channel_id,
                content: content,
                ts: slackMsgRes.ts,
                options: options,
                multivote: false,
            });
            res.send('');
        } catch (e) {
            console.error(e);
            res.sendStatus(500);
        }
    });

    app.post('/vote', async (req: Request, res: Response) => {
        // req has `payload` parameter (parse as json) that corresponds to the button clicked
        // of note: payload.user.id, payload.actions[0].action_id, payload.container.message_ts, payload.container.channel_id
        // see https://api.slack.com/messaging/interactivity/enabling pt 3
        const payload = JSON.parse(req.body.payload);
        const user: string = payload.user.id;
        const option_id: number = parseInt(payload.actions[0].action_id);
        const ts: string = payload.container.message_ts;
        const channel_id: string = payload.container.channel_id;

        try {
            await postMutex.enqueue(channel_id + ':' + ts, async () => {
                await db.vote(channel_id, ts, user, option_id);
                const poll = await db.getPoll(channel_id, ts);
                await slackClient.chat.update({
                    channel: channel_id,
                    ts: ts,
                    blocks: pollContentToBlocks(poll),
                    text: '',
                })
            });
            res.send('');
        } catch (e) {
            console.error(e);
            res.sendStatus(500);
        }
    });

    await app.listen(port);
    console.log(`BASIC POLE listening on port ${port}!`);
}

main()
