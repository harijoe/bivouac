import { CopyField } from './misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** The bivouac address (MCP URL) and the short steps to add it to Claude, Claude Code and ChatGPT. */
export function ChatConnect({ mcpUrl }: { mcpUrl: string }) {
  return (
    <div className="space-y-4">
      <CopyField label="Your bivouac address" value={mcpUrl} />
      <Tabs defaultValue="claude">
        <TabsList>
          <TabsTrigger value="claude">Claude</TabsTrigger>
          <TabsTrigger value="code">Claude Code</TabsTrigger>
          <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
        </TabsList>
        <TabsContent value="claude">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>On claude.ai (or the desktop app), open <b>Settings → Connectors</b>.</li>
            <li>Choose <b>Add custom connector</b>, paste the address above and confirm.</li>
            <li>Click <b>Connect</b>: sign in with GitHub here, then <b>Allow</b>.</li>
            <li>Ask Claude: <i>“Using bivouac, add a dark mode to my-app.”</i></li>
          </ol>
        </TabsContent>
        <TabsContent value="code">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Run this in your terminal:<div className="mt-1.5"><CopyField value={`claude mcp add --transport http bivouac ${mcpUrl}`} /></div></li>
            <li>Start <code className="font-mono">claude</code>, type <code className="font-mono">/mcp</code>, pick <b>bivouac</b> and sign in.</li>
          </ol>
        </TabsContent>
        <TabsContent value="chatgpt">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>In ChatGPT, open <b>Settings → Connectors → Advanced</b> and turn on <b>Developer mode</b>.</li>
            <li>Choose <b>Create</b>, paste the address above and select <b>OAuth</b> as the authentication.</li>
            <li>Sign in with GitHub when asked, then <b>Allow</b>.</li>
          </ol>
        </TabsContent>
      </Tabs>
    </div>
  );
}
