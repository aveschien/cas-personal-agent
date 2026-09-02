const event = {
  type: "im.message.receive_v1",
  event_id: "delivery-live-1",
  message_id: "om_live_1",
  chat_id: "oc_private_1",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_authorized",
  sender_type: "user",
  content: "继续报价项目",
  create_time: "1788370800000",
  timestamp: "1788370801000",
};

process.stderr.write(
  "[event] ready event_key=im.message.receive_v1\n",
);
process.stdin.resume();

setTimeout(() => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}, 30);

process.once("SIGTERM", () => {
  process.stderr.write(
    "[event] exited — received 1 event(s) in 0s (reason: signal)\n",
  );
  process.exit(0);
});
