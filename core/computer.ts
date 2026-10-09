// computer sessions: what an agent drives when it needs a real screen.
// v1 ships this interface only. real providers land in a later phase.
// clean-room original code for silk by layered innovation.

export interface ComputerSession {
  id: string;
  screenshot(): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  typeText(t: string): Promise<void>;
  close(): Promise<void>;
}

export interface ComputerProvider {
  id: string;
  launch(): Promise<ComputerSession>;
}

// future providers plug in here: implement ComputerProvider against a
// cloud vm account (launch a session, stream the screen over the network).
// needs the user's cloud credentials, out of scope for v1, so this stub
// fails loudly instead of pretending to work.
export class StubComputer implements ComputerProvider {
  readonly id = "stub";

  async launch(): Promise<ComputerSession> {
    throw new Error(
      "[stub-computer] computer sessions are not wired yet in v1. " +
        "add a real ComputerProvider with your cloud account credentials " +
        "to drive cloud computers from silk."
    );
  }
}
