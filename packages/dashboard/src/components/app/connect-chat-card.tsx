import { MessageSquare } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/lib/router';
import { ChatConnect } from './chat-connect';

/** Home block: the full "connect your chat" instructions until a chat has connected, then a single line. */
export function ConnectChatCard({ mcpUrl, connected }: { mcpUrl: string; connected: boolean }) {
  if (connected) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <MessageSquare className="size-4" aria-hidden="true" />Chat connected · <Link to="/settings/chat" className="underline underline-offset-4 hover:text-foreground">manage</Link>
      </p>
    );
  }
  return (
    <Card id="connect-chat">
      <CardHeader>
        <CardTitle>Connect your chat</CardTitle>
        <CardDescription>Add bivouac to Claude or ChatGPT, then start tasks by talking to it. You can also start them from the dashboard.</CardDescription>
      </CardHeader>
      <CardContent><ChatConnect mcpUrl={mcpUrl} /></CardContent>
    </Card>
  );
}

/** One-line reminder (new-task form) that tasks can also be started from a chat. */
export function ConnectChatHint({ connected }: { connected: boolean }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <MessageSquare className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        You can also start tasks from Claude or ChatGPT.{' '}
        <Link to={connected ? '/settings/chat' : '/'} className="underline underline-offset-4 hover:text-foreground">{connected ? 'Manage the connection' : 'Connect your chat'}</Link>
      </span>
    </p>
  );
}
