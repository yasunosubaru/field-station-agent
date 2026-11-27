# Store kit

Reusable CSS and JS components extracted from the measured store clone: the same sizes, rhythm and motion,
rewritten so they adapt to any page instead of reproducing one page pixel for pixel.

- **No build step.** Link one stylesheet and one script.
- **No hard-coded values in components.** Every colour, size, space, radius and duration is a token
  (`css/tokens.css`) or a knob of the component (a custom property such as `--card-w`).
- **Fluid.** Display type scales with `clamp()` between the compact (≤ 734 px) and full (≥ 1068 px) layouts;
  shelves switch card sizes with container queries, so a component adapts to the slot you give it.
- **Easy to override.** Everything sits in cascade layers (`kit.tokens < kit.base < kit.components`):
  your own CSS wins without `!important`.

Open `index.html` for the core components and `examples/` for the global nav, footer, modal, tabs, carousel,
comparator, box contents, promo ribbon, bag and store finder. `examples/store.html` is the clone's store home
rebuilt with the kit only.

## Use it

```html
<link rel="stylesheet" href="kit/css/kit.css">
<body class="kit">
  …
  <script src="kit/js/kit.js" defer></script>
</body>
```

`class="kit"` on a container scopes the reset and base type to it, so the kit can live inside an existing page.

## Customise

Change a token for the whole page:

```css
:root { --kit-action: #2d6a4f; --kit-radius-lg: 24px; --kit-font: "Inter", sans-serif; }
```

Change one component through its knobs:

```css
.my-promo .kit-card { --card-w: 480px; --card-h: 360px; --card-pad: 40px; }
.kit-gallery { --gallery-ratio: 1; --gallery-bg: var(--kit-surface); }
.kit-localbar { --localbar-top: 44px; }   /* when a global nav stays above it */
```

## Components

| Component | Classes | Behaviour (`kit.js`) |
|---|---|---|
| Button, links, eyebrow | `kit-btn` (`--large`, `--block`, `--secondary`, `--outline`, `--dark`, `--light`), `kit-btn-row`, `kit-link-more`, `kit-eyebrow` | — |
| Promo ribbon | `kit-ribbon` (`--action`), `__inner`, `__msg` | `data-kit-ribbon`: arrows through several messages |
| Page header | `kit-page-head`, `__title`, `__aside`, `__links` | — |
| Section heading (two tones) | `kit-section-head` with `<strong>` | — |
| Content card | `kit-card` (`--dark`, `--black`, `--short`, `--cover`, `--icon` with `__icon`), `__body`, `__title`, `__text`, `__media`, `__link` | — |
| Product card | `kit-card kit-product`, `__name`, `__swatches`, `__info`, `__price` | — |
| Shelf (card row) | `kit-shelf`, `__track` | `data-kit-shelf`: arrows |
| Category row | `kit-catnav` (on a `kit-shelf`), `__item`, `__img`, `__label` | `data-kit-shelf`: arrows |
| Local bar | `kit-localbar`, `__inner`, `__title`, `__links`, `__action` | `data-kit-sticky`: bottom rule once stuck |
| Configurator step and options | `kit-step`, `__title`, `kit-options` (`--2`, `--3`), `kit-option`, `__label`, `__name`, `__sub`, `__price`, `kit-help` | — |
| Colour swatches | `kit-swatches`, `kit-swatch`, `kit-swatches__label` | `data-kit-swatches`: names the checked colour |
| Gallery | `kit-gallery`, `__track`, `__slide` | `data-kit-gallery` (`="compact"`): arrows and dots |
| Summary | `kit-summary`, `__title`, `__price`, `__fine` | — |
| Accordion | `kit-accordion`, `__item`, `__button`, `__panel` | `data-kit-accordion` |
| Global nav | `kit-nav` (`--sticky`), `__bar`, `__logo`, `__list`, `__link`, `__tools`, `__burger`, `__flyout`, `__panel` (`--wide`), `__group` (`--lead`) | `data-kit-nav`: flyouts on hover/focus, search, bag, mobile menu (`KitNav.open/close/badge`) |
| Footer | `kit-footer`, `__notes`, `__crumbs`, `__dir`, `__col`, `__section`, `__title`, `__list`, `__shop`, `__legal` | `data-kit-footer`: directory collapses on narrow footers |
| Modal | `<dialog class="kit-modal">` (`--wide`), `__panel`, `__close`, `__content`, `__title`, `__foot` | `data-kit-modal-open="id"` (`KitModal.open/close`) |
| Tabs | `kit-tabs` (`--line`, `--pill`, `--segmented`), `kit-tab`, `kit-tab-panel` | `data-kit-tabs`: arrows, Home, End (`KitTabs.select`) |
| Autoplay carousel | `kit-carousel`, `__viewport`, `__track`, `__slide` | `data-kit-carousel`: timed dots, play/pause, pauses on hover, focus and off screen |
| Model comparator | `kit-compare` (`--roomy`, `--cols`), `__head`, `__grid`, `__row`, `__name`, `__price`, `__icon`, `__value` | — |
| Bag page | `kit-bag`, `__empty`, `__full`, `__title`, `__line` (`data-price`), `__img`, `__info`, `__name`, `__qty`, `__remove`, `__price`, `__summary`, `__row` (`--total`) | `data-kit-bag`: quantity, remove, totals, empty state (`KitBag.init`, event `kit-bag:change`) |
| Store finder | `kit-stores`, `__search`, `__label`, `__heading`, `__none`, `kit-field`, `kit-store`, `__map`, `__body`, `__name`, `__address`, `__hours` | `data-kit-stores`: filters the cards as you type |
| What's in the box | `kit-box`, `__title`, `__items`, `__item`, `__visual`, `__label`, `__note` | — |

Each CSS file starts with the markup it expects.

## Kit and clone

The clone (`pages/`, `assets/`) reproduces the reference store at 97–99/100 and keeps its measured values on
purpose. The kit takes the same values as defaults, but lays them out with flex, grid, `clamp()` and container
queries. Build new pages with the kit; read the clone to see how the original arranges them.

How close the kit gets: `examples/store.html` rebuilds the clone's store home (`index.html`) with kit classes only,
same demo content. Scored section by section with the clone's own diff tool, it reaches **99/100 at 1440 px** and
**97/100 at 390 px**:

```sh
node tools/visual-diff.mjs http://localhost:4321/kit/examples/store.html "http://localhost:4321/index.html?content=demo" /tmp/kit-score
```
