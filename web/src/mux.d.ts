// mux.js ships without types; only the stream parsers used for captions are declared.
declare module 'mux.js/lib/m2ts/m2ts.js' {
  interface MuxStream {
    push(data: unknown): void;
    flush(): void;
    pipe<T>(dest: T): T;
    on(event: string, listener: (data: never) => void): void;
  }
  const m2ts: {
    TransportPacketStream: new () => MuxStream;
    TransportParseStream: new () => MuxStream;
    ElementaryStream: new () => MuxStream;
    CaptionStream: new (options?: { parse708captions?: boolean }) => unknown;
  };
  export default m2ts;
}
declare module 'mux.js/lib/codecs/h264.js' {
  export const H264Stream: new () => {
    push(data: unknown): void;
    on(event: string, listener: (data: never) => void): void;
  };
}
