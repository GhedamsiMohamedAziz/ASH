// M365 MCP (instructions.md §14): Outlook / Calendar / SharePoint via MS Graph,
// delegated (OBO). Reads/summarize are allow; SEND is approval-gated (§2.3, §9.4).
// The Gateway injects the delegated Graph token (§13.2). Personal connectors are
// disabled in Mode B (§3.4) — enforced upstream by team_mode.

export interface Ctx { credential: string; userId: string }

export interface M365Backend {
  listMail(folder: string, ctx: Ctx): Promise<Array<{ id: string; subject: string; from: string }>>;
  readMail(id: string, ctx: Ctx): Promise<{ subject: string; body: string }>;
  sendMail(to: string, subject: string, body: string, ctx: Ctx): Promise<{ id: string }>;
  searchFiles(query: string, ctx: Ctx): Promise<string[]>; // SharePoint/OneDrive
  createEvent(title: string, startIso: string, ctx: Ctx): Promise<{ id: string }>;
}

export class StubM365 implements M365Backend {
  async listMail() {
    return [{ id: "m1", subject: "Q3 review", from: "ceo@acme.com" }];
  }
  async readMail(id: string) {
    return { subject: "Q3 review", body: "Please prepare the numbers." };
  }
  async sendMail(to: string, subject: string) {
    return { id: "sent_1" };
  }
  async searchFiles(query: string) {
    return [`sites/finance/${query}.xlsx`];
  }
  async createEvent(title: string) {
    return { id: "evt_1" };
  }
}

export class M365Mcp {
  private b: M365Backend;
  constructor(backend: M365Backend = new StubM365()) {
    this.b = backend;
  }
  // Tools whose name ends the approval decision to tool_policies (m365.send_mail → require_approval).
  tools(): Record<string, (a: any, ctx: Ctx) => Promise<unknown>> {
    return {
      "m365.list_mail": (a, ctx) => this.b.listMail(String(a.folder ?? "inbox"), ctx),
      "m365.read_mail": (a, ctx) => this.b.readMail(String(a.id), ctx),
      "m365.send_mail": (a, ctx) => this.b.sendMail(String(a.to), String(a.subject), String(a.body), ctx),
      "m365.search_files": (a, ctx) => this.b.searchFiles(String(a.query ?? ""), ctx),
      "m365.create_event": (a, ctx) => this.b.createEvent(String(a.title), String(a.start), ctx),
    };
  }
}
