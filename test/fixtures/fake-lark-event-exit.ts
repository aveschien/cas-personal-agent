process.stderr.write(
  "[event] ready event_key=im.message.receive_v1\n",
);
process.stdin.resume();

setTimeout(() => {
  process.exit(23);
}, 20);
