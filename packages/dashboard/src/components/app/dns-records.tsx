import { dnsPlan } from '@bivouac/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** The two A records to create at the registrar, with names relative to the zone (`@` and `*` for a root domain). */
export function DnsRecords({ domain, ip }: { domain: string; ip: string | null }) {
  const plan = dnsPlan(domain, ip ?? 'this server’s IP');
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm text-muted-foreground">At your registrar, in the DNS zone of <b className="text-foreground">{plan.zone}</b>, create these two records:</p>
      <Table>
        <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Name</TableHead><TableHead>Value</TableHead></TableRow></TableHeader>
        <TableBody>
          {plan.records.map((r) => (
            <TableRow key={r.name}>
              <TableCell>{r.type}</TableCell>
              <TableCell><code className="font-mono text-xs">{r.name}</code></TableCell>
              <TableCell><code className="font-mono text-xs">{r.value}</code></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">Some registrars want the full name instead of <code className="font-mono">@</code>: that is <code className="font-mono">{domain}</code>.</p>
    </div>
  );
}
