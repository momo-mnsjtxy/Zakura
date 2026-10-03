export function createConnectionTracker() {
  let connected = false;
  return {
    connect() {
      const reconnect = connected;
      connected = true;
      return reconnect;
    },
    reset() {
      connected = false;
    },
  };
}
