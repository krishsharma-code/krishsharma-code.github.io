# krishsharma-code.github.io

Static dev blog for Krish Sharma (krishsharma-code). Posts live in `posts/`, styles in `assets/style.css`.
Each post is a plain HTML page with a canonical URL, so Medium can import it with the canonical link intact.

## Images

Screenshots live in `assets/img/` and are captured from the repository a post is
about — real terminal output or real files, never stock or generated artwork.

- Content column is **676px** wide (`720px` max-width minus `44px` padding).
- Render every screenshot at **1352px** (2x the column) so it is crisp on retina,
  then declare `width="676"` and the matching height on the `<img>`.
- Set `og:image` and the JSON-LD `image` to the same file, with its real
  pixel dimensions.
- Each figure gets a `<figcaption>` saying which command produced the output.
