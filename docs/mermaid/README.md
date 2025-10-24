# Mermaid Diagrams

Source `.mmd` files live in this directory so we can iterate on diagrams and
export static assets when needed.

## Generating PNG/SVG assets

1. Install the Mermaid CLI (requires Node 18+):
   ```bash
   npm install -g @mermaid-js/mermaid-cli
   ```
2. Render any chart:
   ```bash
   mmdc -i controller-flow.mmd -o controller-flow.png
   mmdc -i controller-flow.mmd -o controller-flow.svg
   ```
3. Commit the exported PNG/SVG next to the source when ready for documentation.

Feel free to add more `.mmd` files here; the CLI can batch render with globs:

```bash
mmdc -i '*.mmd' -o '.png'
```
