# multi-app example

A front (`web`, port 5173), an API (`api`, port 3000) and a Postgres sidecar, declared in `bivouac.yml`.
Each bivouac task gets its own three of them: `https://<task>.<project>.<domain>` for the front and `https://api.<task>.<project>.<domain>` for the API.
