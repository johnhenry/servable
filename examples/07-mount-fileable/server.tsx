/**
 * A fileable Descriptor tree mounted as a raw child of `<Group>`, written
 * as literal `<Dir>`/`<File>` JSX nested directly inside servable's own
 * `<Router>`/`<Group>` -- one file, one `@jsxImportSource
 * @johnhenry/servable` pragma, both vocabularies used adjacently in the
 * same expression. fileable describes the virtual filesystem, servable
 * serves it, with zero disk writes in between.
 *
 * This works because servable's `jsx()` calls any function-typed tag
 * directly with its props, so `<Dir>`/`<File>` (evaluated under
 * servable's pragma) invoke fileable's own `Dir`/`File` functions and
 * produce real fileable `Descriptor`s -- identical to calling them by
 * hand. `Descriptor.tag`'s type is the general `symbol` (not each
 * package's own exact `typeof FRAGMENT`) specifically so this
 * type-checks; see the README's "Mounting without from=" section for the
 * full story, including the equivalent `Dir({...})`/`{site}` function-call
 * form for when the tree is built programmatically instead of written out
 * literally.
 *
 * Run with:
 *   npm run build && node dist/examples/07-mount-fileable/server.js
 * Then:
 *   curl http://localhost:3006/site/                    # index.html at the dir's own path
 *   curl http://localhost:3006/site/about/index.html
 */
/** @jsxImportSource @johnhenry/servable */
import { Dir, File } from "@johnhenry/fileable";
import { Router, Group, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

const app = (
  <Router>
    <Group prefix="/site">
      <Dir name="dist">
        <File name="index.html">
          {`<!doctype html><html><body><h1>Home</h1><a href="/site/about/index.html">About</a></body></html>`}
        </File>
        <Dir name="about">
          <File name="index.html">{`<!doctype html><html><body><h1>About</h1></body></html>`}</File>
        </Dir>
      </Dir>
    </Group>
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3006 });
console.log("listening on http://localhost:3006");
