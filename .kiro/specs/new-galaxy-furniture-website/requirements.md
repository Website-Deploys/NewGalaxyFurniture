# Requirements Document

## Introduction

New Galaxy Furniture (NGF) is a Bengaluru-based furniture manufacturer and showroom serving Karnataka. This specification defines a premium catalogue website whose single business objective is to convert browsing into WhatsApp enquiries and phone calls. There is no shopping cart, no checkout, no payment, and no customer accounts — the conversion endpoint is always a WhatsApp message or a phone call to one of the two published business numbers.

The system has two faces. The public face is a fast, editorial, motion-rich furniture catalogue covering nine product categories, with instant client-side search, filtering, sorting, auto-generated product detail pages, and conversion affordances on every surface. The internal face is an admin system where a non-technical operator authenticates, creates and edits products (manually or with AI assistance), manages categories, reviews, leads, homepage content and settings, and publishes content through a controlled lifecycle. Structured content is stored as validated JSON in the repository under `/data` and is baked into the deployed bundle at build time; drafts are held outside the public bundle so unpublished work is never visible to visitors.

One constraint cuts across every requirement in this document: the system must never state a business fact that the operator has not supplied. Years in business, certifications, awards, customer or employee or showroom counts, delivery-time guarantees, warranty terms, and market-position superlatives are never generated, never hard-coded, and never inferred. Where a fact is unknown, the system renders a clearly marked placeholder and exposes an admin-editable field. The same honesty rule governs metrics (measured versus operator-set rankings), pricing (no fabricated discounts), and AI output (suggestions are labelled and never auto-published).

## Glossary

- **NGF_Site**: The complete deployed system, comprising the public catalogue, the admin application, and the server-side API routes.
- **Catalogue**: The set of products whose product status is PUBLISHED or OUT_OF_STOCK, together with the published categories that organise them.
- **Product_Status**: The lifecycle state of a product record: DRAFT, REVIEW, PUBLISHED, UNPUBLISHED, or OUT_OF_STOCK. Determines whether the product is present in the public build.
- **Stock_Status**: The commercial availability of a product: IN_STOCK, LIMITED_STOCK, OUT_OF_STOCK, or MADE_TO_ORDER. Independent of Product_Status except where an invariant links them.
- **Draft**: A product record whose Product_Status is DRAFT or REVIEW. Excluded from the public build and from all public surfaces.
- **Publish_Gate**: The set of completeness checks a product record must satisfy before it may reach Product_Status PUBLISHED or OUT_OF_STOCK: name, category, SKU, description, price or price-on-enquiry, at least one image, stock status, and alt text on every image.
- **Price_On_Enquiry**: A product state in which no numeric price is published and the public surfaces display the label "Price on enquiry" instead of an amount.
- **Slug**: The lowercase hyphenated URL identifier of a product or category. A product's slug is also its content filename and is treated as a stable public URL contract.
- **SKU**: The operator-facing product code, category-prefixed, unique across the catalogue, and included in every product enquiry message.
- **Enquiry_Message**: The pre-filled plain-text WhatsApp message generated for a specific product, category, or general enquiry, always naming the product and SKU where a product is in context.
- **Lead**: A record created when a visitor submits any enquiry form, containing the visitor's supplied contact details plus server-derived context. Personal data, stored outside the content repository.
- **Lead_Status**: The operator-managed state of a lead: NEW, CONTACTED, FOLLOW_UP, CONVERTED, or CLOSED.
- **Derivative**: A resized and re-encoded copy of an uploaded image, generated once at upload time in a fixed set of widths and formats and served immutably.
- **LQIP**: Low-Quality Image Placeholder — a tiny inlined image rendered in a media slot before the full image loads, so no image slot ever paints empty.
- **Provenance**: The recorded origin of a product field value: `admin` (asserted by the operator) or `ai` (suggested by the AI assistant). Displayed in the admin UI and persisted with the product.
- **Admin_Facts**: The set of values the operator explicitly supplied to the AI Product Assistant. The only permitted source of factual claims in generated content.
- **Fact_Guard**: The deterministic server-side filter that blanks unsupplied factual fields, forces admin-supplied values to win, and scrubs banned claims from AI-generated free text.
- **Curated_Ranking**: An ordering set manually by the operator rather than derived from measured data, labelled as curated wherever it is presented.
- **Measured_Metric**: A count derived from recorded visitor events, as distinct from a Curated_Ranking or operator-set value.
- **Content_Repository**: The Git repository holding structured content as JSON under `/data`, which is the source of truth for products, categories, reviews, and site settings.
- **Path_Allowlist**: The fixed set of content file paths the admin write pipeline is permitted to write; every other path is refused.
- **Publish_Deploy**: The build and deployment triggered by a content change that alters published state, after which the change becomes publicly visible.
- **Admin_Operator**: An authenticated internal user of the admin application, holding the role owner, editor, or viewer.
- **Motion_Primitive**: One of the nine reusable animated 2D SVG illustration components.
- **Reduced_Motion**: The visitor preference expressed by `prefers-reduced-motion: reduce`.

## Requirements

### Requirement 1: Public Catalogue Browsing and Product Cards

**User Story:** As a prospective customer, I want to browse New Galaxy Furniture's products by category and see the essential details on each card, so that I can identify pieces worth enquiring about without opening every page.

#### Acceptance Criteria

1. THE NGF_Site SHALL serve a catalogue listing route at `/collection` presenting every product in the Catalogue, including products whose Product_Status is OUT_OF_STOCK, and no other product record.
2. THE NGF_Site SHALL serve one category route for each of the nine category slugs `sofas`, `beds`, `dining-tables`, `dining-chairs`, `accent-chairs`, `coffee-side-tables`, `storage-display`, `office`, and `outdoor`, at the path `/collection/{category-slug}`.
3. WHEN a category route for one of the nine category slugs is requested, THE NGF_Site SHALL present every Catalogue product assigned to that category and no product that is not assigned to that category, presenting a product assigned to more than one category on each of those categories' routes.
4. IF a requested `/collection/{category-slug}` path does not match one of the nine category slugs, THEN THE NGF_Site SHALL render a not-found state that states the requested category does not exist and offers links to search and to the nine category routes, and SHALL NOT render an empty product listing.
5. THE NGF_Site SHALL render each product card with the product's primary image, the product name, the price or the label "Price on enquiry", a visible stock status label corresponding to the product's Stock_Status value, exactly one category or tag label, and a Quick Enquire control.
6. WHERE a product has a numeric price, THE NGF_Site SHALL format the amount with the `₹` symbol and Indian digit grouping with no fractional digits, such that 100000 renders as `₹1,00,000`.
7. WHERE a product is in the Price_On_Enquiry state, THE NGF_Site SHALL display the label "Price on enquiry" in place of any amount, and SHALL NOT display any numeric amount on that card.
8. WHILE a product card's image has not finished loading, and IF the image fails to load, THEN THE NGF_Site SHALL render the product's LQIP or a designed placeholder in the media slot together with the image's alt text, such that no card media slot paints empty.
9. WHEN a visitor activates any part of a product card other than the Quick Enquire control, whether by pointer activation or by keyboard activation while the card is focused, THE NGF_Site SHALL navigate to that product's detail page at that product's slug URL.
10. WHEN a visitor activates the Quick Enquire control on a product card, whether by pointer activation or by keyboard activation while the control is focused, THE NGF_Site SHALL open the product enquiry affordance for that product without navigating away from the current listing route and without discarding the visitor's current scroll position or applied listing state.
11. WHILE a pointing device hovers a product card on a viewport of 768 px or wider, THE NGF_Site SHALL raise the card by 2 px, cross-fade to the product's second image where a second image exists, and reveal the card's directional arrow.
12. WHEN the pointing device ceases to hover a product card, THE NGF_Site SHALL return the card to its unraised position, restore the product's primary image, and hide the card's directional arrow.
13. WHERE Reduced_Motion is expressed by the visitor, THE NGF_Site SHALL present the hovered and non-hovered card states without animated transition, and SHALL keep the card, its image, and its directional arrow fully readable and operable in both states.
14. WHERE the visitor's device reports no hover capability, THE NGF_Site SHALL make the card fully usable without hover, SHALL NOT request the second card image, and SHALL render the Quick Enquire control as a separate tap target of at least 44 px in each dimension.
15. IF the Catalogue contains no product matching the requested route, whether `/collection` or a category route, THEN THE NGF_Site SHALL render a designed empty state offering search and other categories rather than a blank listing.
16. THE NGF_Site SHALL exclude every Draft and every UNPUBLISHED product from all public catalogue listings, from every category route, and from every product count presented on those surfaces.

### Requirement 2: Catalogue Search with Live Suggestions

**User Story:** As a prospective customer, I want to search the catalogue and see suggestions as I type, so that I can reach a specific piece in a few keystrokes.

#### Acceptance Criteria

1. THE NGF_Site SHALL provide a search control in the site header on every public page, with the placeholder text "Search by name, SKU, material, colour...", reachable by keyboard tab order without opening any menu.
2. WHEN a visitor types into the search control, THE NGF_Site SHALL match the case-insensitive, leading-and-trailing-whitespace-trimmed query against product name, SKU, material, colour, category, subcategory, and tags, and SHALL produce matches on the visitor's device without a server round-trip.
3. WHEN a visitor types a query of four or more characters, THE NGF_Site SHALL apply fuzzy matching that tolerates a maximum of one character edit (insertion, deletion, or substitution) per five characters of the query, rounded down.
4. WHEN a visitor types a query of fewer than four characters, THE NGF_Site SHALL match by exact value and by prefix only, and SHALL exclude fuzzy matches.
5. WHEN a visitor enters a complete SKU in any letter case, THE NGF_Site SHALL return the product bearing that SKU as the first result.
6. WHILE suggestions are displayed, THE NGF_Site SHALL show at most eight suggestions, ordered products first, then categories, then filter suggestions, each rendering a visible label and a single activatable destination; where fewer than eight suggestions qualify, it SHALL show all qualifying suggestions.
7. WHEN a visitor presses a key in the search control, THE NGF_Site SHALL delay the suggestion update by 120 ms after that keystroke and SHALL render only the suggestions for the most recently typed query, discarding results of superseded queries.
8. WHILE the suggestion list is open, THE NGF_Site SHALL move the active suggestion on ArrowUp and ArrowDown, activate the active suggestion's destination on Enter, close the list and retain the typed text and input focus on Escape, and SHALL expose the active suggestion to assistive technology as the currently active option.
9. WHEN a visitor focuses the empty search control, THE NGF_Site SHALL display up to five of that visitor's most recent searches retained on the visitor's own device, most recent first.
10. IF a query matches no product, THEN THE NGF_Site SHALL present the three nearest matches, or all available nearest matches where fewer than three exist, together with category shortcuts, and SHALL not render an empty result area.
11. THE NGF_Site SHALL restrict search results and suggestions to Catalogue products, excluding every Draft product.
12. WHEN a visitor activates a suggestion by pointer or by Enter, THE NGF_Site SHALL navigate to that suggestion's destination and close the suggestion list.
13. WHEN a visitor activates a suggestion or submits a query of one or more characters, THE NGF_Site SHALL record that query on the visitor's own device as the most recent search, retaining at most five distinct entries and discarding the oldest beyond five.
14. IF the client-side search data required to match a query is unavailable, THEN THE NGF_Site SHALL retain the visitor's typed text, display a message indicating that search is temporarily unavailable, and offer category navigation in place of suggestions.

### Requirement 3: Catalogue Filtering and Sorting

**User Story:** As a prospective customer, I want to narrow the catalogue by the attributes I care about and order the results, so that I can find furniture that fits my room, budget, and taste.

#### Acceptance Criteria

1. THE NGF_Site SHALL provide filters for category, price band, availability, material, colour, size, and style, presenting all seven dimensions simultaneously on the catalogue surface and allowing any combination of them to be active at the same time.
2. THE NGF_Site SHALL offer exactly the price bands Any, Under ₹25,000, ₹25,000–₹50,000, ₹50,000–₹1,00,000, and ₹1,00,000+, with Any selected until the visitor chooses otherwise.
3. THE NGF_Site SHALL offer exactly the availability options Any, In Stock, and Made to Order, with Any selected until the visitor chooses otherwise.
4. WHEN a visitor selects multiple values within one filter dimension, THE NGF_Site SHALL return products matching any selected value in that dimension and matching every constrained dimension, and SHALL treat every unconstrained dimension as imposing no restriction.
5. WHEN a visitor changes any filter or sort selection, THE NGF_Site SHALL update the displayed results within 300 milliseconds of the selection and SHALL reflect the complete filter and sort state in the page URL query string within the same update, without a full page reload.
6. WHEN a page is loaded from a URL carrying filter and sort parameters, THE NGF_Site SHALL restore the identical filter and sort state that produced that URL, so that the rendered result set and its order match those of the originating page.
7. THE NGF_Site SHALL derive every filter option and its result count from the Catalogue data at runtime rather than from a fixed list, and SHALL recompute every displayed count in the same update as the results so that each count equals the number of products that would be returned if that option were selected alongside the currently active selections in all other dimensions.
8. WHERE a filter option would yield zero results, THE NGF_Site SHALL render that option in a disabled state showing a count of zero and rejecting selection, rather than removing it.
9. WHERE a product is in the Price_On_Enquiry state, THE NGF_Site SHALL exclude that product from every banded price filter result and SHALL include it under the Any price band with its "Price on enquiry" label.
10. THE NGF_Site SHALL offer exactly the sort options Newest, Price Low to High, Price High to Low, Most Viewed, Best Selling, and Trending.
11. WHEN a visitor sorts by price in either direction, THE NGF_Site SHALL order priced products by price in the selected direction and SHALL place every Price_On_Enquiry product after every priced product in both directions.
12. THE NGF_Site SHALL produce a deterministic total ordering for every sort option, breaking every tie on ascending slug, so that repeated renders of the same result set present the same order.
13. WHERE a sort option is derived from a Curated_Ranking rather than a Measured_Metric, THE NGF_Site SHALL label that option as curated in the sort control and SHALL NOT present any measurement date for those results.
14. WHERE a Measured_Metric is available for a sort option, THE NGF_Site SHALL label those results as measured and SHALL present the date of the measurement snapshot alongside the results.
15. IF a Measured_Metric for a requested sort option is unavailable, THEN THE NGF_Site SHALL fall back to the operator's manual ordering, SHALL label the results as curated, SHALL NOT present a measurement date, and SHALL retain the visitor's selected sort option in the control and in the URL query string.
16. THE NGF_Site SHALL present the Best Selling sort as a Curated_Ranking, because the system records no transactions, and SHALL NOT present any transaction-derived count or measurement date for that option.
17. IF a filter combination yields no products, THEN THE NGF_Site SHALL display a designed empty state containing no product results, a message indicating that no products match the current filters, and a single control that clears all filters; activating that control SHALL remove every filter parameter from the URL query string, retain the current sort selection, and render the full Catalogue.
18. WHEN the catalogue is loaded from a URL carrying no filter or sort parameters, THE NGF_Site SHALL apply no filters, SHALL apply the Newest sort option, and SHALL display every product in the Catalogue.
19. IF a URL carries a filter or sort parameter that is unrecognised, malformed, or names a value absent from the Catalogue, THEN THE NGF_Site SHALL ignore only that parameter, apply the remaining valid parameters, render the catalogue without an error page, and rewrite the URL query string to the state actually applied.
20. WHEN a visitor navigates backward or forward through browser history across catalogue states, THE NGF_Site SHALL restore the filter and sort state recorded for the target history entry and SHALL display the results and ordering for that state.

### Requirement 4: Product Detail Page

**User Story:** As a prospective customer, I want a complete product page for every piece in the catalogue, so that I can evaluate it and start an enquiry with full context.

#### Acceptance Criteria

1. WHEN a product's Product_Status becomes PUBLISHED or OUT_OF_STOCK, THE NGF_Site SHALL make a detail page available at `/product/{slug}` after the next Publish_Deploy, without any manual page authoring.
2. THE NGF_Site SHALL render on each product detail page the breadcrumb trail from the catalogue root through the product's category to the product name, product name, SKU, price or the "Price on enquiry" label, stock status, image gallery, description, material, dimensions, colour, available colours, variants, customization information, delivery information, made-to-order information, a WhatsApp enquiry control, a Call control, related products, and recently viewed products.
3. WHERE a product field holds no value, THE NGF_Site SHALL omit that field's display block rather than rendering an empty label or a placeholder value.
4. WHILE the viewport is 1024 px or wider, THE NGF_Site SHALL present the gallery as a large primary image with a thumbnail rail listing every image of that product, SHALL mark the thumbnail matching the displayed primary image as current, and WHEN a visitor activates a thumbnail, THE NGF_Site SHALL replace the primary image with that image without navigating away from the page.
5. WHILE the viewport is narrower than 768 px, THE NGF_Site SHALL present the gallery as a swipeable sequence with position indicators reporting the displayed image's position and the total image count, and with touch-operable previous and next controls of at least 44 px in each dimension.
6. WHEN a visitor activates zoom or fullscreen on a gallery image, THE NGF_Site SHALL display the largest available Derivative of that image, and WHEN the visitor presses Escape or activates the close control, THE NGF_Site SHALL exit zoom or fullscreen and return focus to the control that opened it.
7. THE NGF_Site SHALL select related products deterministically from shared category, subcategory, tags, material, colour, and price proximity, honouring any operator-specified related products first in the operator's own order, ordering the remainder by count of shared attributes then by price proximity and breaking ties on slug, so that repeated renders of the same catalogue present the same related products in the same order and no selection or ordering is random or time-varying.
8. THE NGF_Site SHALL exclude the current product from its own related products, SHALL restrict related products to Catalogue products, and SHALL present at most eight related products.
9. IF no product shares any attribute with the current product, THEN THE NGF_Site SHALL omit the related products section rather than displaying unrelated furniture.
10. WHEN a visitor views a product detail page, THE NGF_Site SHALL record that product as the most recent entry in a recently viewed list of at most eight entries stored on the visitor's own device, with no account and no server-side visitor record, SHALL move an existing entry for that product to the most recent position rather than duplicating it, and SHALL discard the oldest entry once the list would exceed eight entries.
11. WHERE the recently viewed list holds fewer than two products other than the current product, or the visitor's device retains no such list, THE NGF_Site SHALL omit the recently viewed section, and otherwise SHALL present those products most recent first, excluding the current product.
12. WHERE a product's Product_Status is OUT_OF_STOCK, THE NGF_Site SHALL keep the detail page available at `/product/{slug}` with HTTP status 200, SHALL display the stock status as out of stock, and SHALL present the WhatsApp enquiry control and the Call control as an availability enquiry rather than removing, hiding, or disabling either control.
13. IF a request names a slug with no PUBLISHED or OUT_OF_STOCK product, THEN THE NGF_Site SHALL respond with HTTP status 404 and a page offering the relevant category and search, and SHALL NOT respond with status 200 and SHALL NOT redirect the request to the homepage, the catalogue, or another product.
14. WHILE the viewport is 768 px or wider and narrower than 1024 px, THE NGF_Site SHALL present the gallery as a single primary image with position indicators reporting the displayed image's position and the total image count, and with previous and next controls operable by both pointer and touch.
15. WHILE keyboard focus is within the gallery, THE NGF_Site SHALL display the previous image on ArrowLeft and the next image on ArrowRight, SHALL take no action on ArrowLeft at the first image or on ArrowRight at the last image, SHALL open zoom or fullscreen on Enter or Space, and SHALL expose the displayed image's position and the total image count to assistive technology.
16. WHERE a product has exactly one image, THE NGF_Site SHALL present that image alone, omitting the thumbnail rail, the position indicators, and the previous and next controls, and SHALL keep the zoom or fullscreen control operable.
17. WHERE Reduced_Motion is expressed, WHEN the displayed gallery image changes, THE NGF_Site SHALL replace the image with no animated transition, cross-fade, or slide.
18. IF a gallery image fails to load, THEN THE NGF_Site SHALL render a styled fallback carrying that image's alt text within the image's reserved slot without changing the surrounding layout, SHALL keep the product's remaining images navigable, and SHALL keep the WhatsApp enquiry control and the Call control operable.

### Requirement 5: WhatsApp and Phone Conversion

**User Story:** As a prospective customer, I want to reach New Galaxy Furniture on WhatsApp or by phone from wherever I am on the site, with the product I am asking about already identified, so that enquiring takes one tap.

#### Acceptance Criteria

1. THE NGF_Site SHALL generate every Enquiry_Message at render time from one message template combined with the current context — a product record, a category, or no context for a general enquiry — and SHALL NOT store or read a per-product message string.
2. WHERE an Enquiry_Message is generated for a specific product, THE NGF_Site SHALL include that product's name and SKU verbatim, character for character as recorded in the product record, in the message text.
3. WHERE an Enquiry_Message is generated for a product whose state is Price_On_Enquiry, THE NGF_Site SHALL include no numeric amount in the message text.
4. WHERE an Enquiry_Message is generated for a category, THE NGF_Site SHALL include that category's name verbatim and no product name or SKU; WHERE it is generated with no product or category context, THE NGF_Site SHALL include neither a product name, a SKU, nor a category name.
5. THE NGF_Site SHALL encode the Enquiry_Message exactly once in the generated WhatsApp link, such that decoding the link's message parameter exactly once yields the original message text character for character, with no residual encoded sequence remaining after that single decode.
6. THE NGF_Site SHALL construct each WhatsApp link with the destination number reduced to the digits 0–9 only, beginning with the country code 91 and containing no `+`, spaces, hyphens, parentheses, or other punctuation.
7. WHEN an Enquiry_Message contains any of `&`, `#`, `+`, `?`, `%`, `=`, a newline, the `₹` symbol, or an emoji, THE NGF_Site SHALL still produce a well-formed URL carrying exactly one message parameter, and decoding that parameter once SHALL reproduce each of those characters unchanged, with every newline preserved as a line break.
8. IF a generated Enquiry_Message would exceed 900 characters, THEN THE NGF_Site SHALL shorten the descriptive portion of the message until the message is at most 900 characters, retaining the product name and SKU in full.
9. THE NGF_Site SHALL display both business numbers +91 95134 43606 and +91 81470 83703 on the header, every product detail page, the contact page, and the footer, and SHALL apply the same label text to both, stating that both are for orders and enquiries.
10. THE NGF_Site SHALL NOT characterise either business number as belonging to a different department, function, or team than the other.
11. THE NGF_Site SHALL render every WhatsApp and phone affordance as a standard link element carrying its destination in the element's own link target, so that long-press, middle-click, copy-link, and open-in-new-tab produce the same destination as activation.
12. WHEN a visitor activates a WhatsApp or phone affordance, THE NGF_Site SHALL leave the current page's scroll position, active filters, search text, and gallery position unchanged.
13. THE NGF_Site SHALL render each phone affordance as a `tel:` link whose value carries a leading `+`, the country code 91, and thereafter digits only.
14. WHILE the viewport is narrower than 768 px, THE NGF_Site SHALL display on every public surface a persistent bottom action bar 56 px in height, offering exactly two controls labelled for WhatsApp and for Call, with additional bottom padding equal to the device's reported bottom safe-area inset.
15. WHILE the viewport is 768 px or wider, THE NGF_Site SHALL NOT display the bottom action bar.
16. WHEN a visitor scrolls downward by 24 px or more cumulatively on a viewport narrower than 768 px, THE NGF_Site SHALL hide the bottom action bar within 300 ms, and WHEN the visitor scrolls upward by 24 px or more, THE NGF_Site SHALL restore it within 300 ms.
17. WHILE the scroll position is within 24 px of the top of the page on a viewport narrower than 768 px, THE NGF_Site SHALL display the bottom action bar irrespective of the most recent scroll direction.
18. WHERE Reduced_Motion is set, THE NGF_Site SHALL hide and restore the bottom action bar without transitional animation, and the bar SHALL remain operable in both states.
19. WHILE the bottom action bar is displayed, THE NGF_Site SHALL reserve page bottom spacing of at least 56 px plus the device's bottom safe-area inset, so that no footer content is obscured by the action bar at any scroll position.
20. THE NGF_Site SHALL NOT present a shopping cart, a checkout, a payment flow, or a customer account facility on any public surface.

### Requirement 6: Lead Capture and Lead Management

**User Story:** As an admin operator, I want every enquiry submitted through the site to arrive as a searchable lead with the product context attached, so that I can follow up quickly and track what happened.

#### Acceptance Criteria

1. THE NGF_Site SHALL provide the enquiry forms Quick Enquire, Request a Callback, Get a Quote, Custom Furniture Enquiry, and Contact.
2. THE NGF_Site SHALL collect on the Custom Furniture Enquiry form the fields name, phone, requirement, approximate budget, dimensions, message, and one optional image.
3. THE NGF_Site SHALL require on every enquiry form a name of 2 to 80 characters, a phone value, and a message of 10 to 1000 characters, SHALL additionally require a product reference on the Quick Enquire form, and SHALL accept at most 500 characters in the requirement field, at most 100 characters in the approximate budget field, and at most 200 characters in the dimensions field.
4. WHEN a visitor submits a phone number as ten digits, with a leading zero, with a `+91` prefix, or with a `91` prefix, with or without internal spaces, THE NGF_Site SHALL normalise the value to a single canonical international form.
5. IF a submitted phone number cannot be normalised to a valid Indian number, or any submitted value violates a required-field rule or a length bound of criterion 3, THEN THE NGF_Site SHALL reject the submission, SHALL create no Lead, SHALL present a field-level message naming each failing field, and SHALL retain every other entered value.
6. WHEN an enquiry submission references a product, THE NGF_Site SHALL resolve the product's name, SKU, and canonical URL on the server from the referenced identifier and SHALL attach those resolved values to the stored Lead rather than any value supplied by the browser.
7. WHEN an enquiry submission passes every validation, anti-spam, and rate-limit check, THE NGF_Site SHALL store exactly one Lead with Lead_Status NEW, a submission date and time taken from the server clock, and the path of the originating page, and SHALL present a confirmation of receipt on the submitting page within 3 seconds of accepting the submission.
8. IF an enquiry submission carries a non-empty hidden anti-spam field, or is submitted less than 1.5 seconds after the form was rendered, THEN THE NGF_Site SHALL reject the submission, SHALL create no Lead, and SHALL present one identical generic rejection message for both cases that does not identify which check failed.
9. THE NGF_Site SHALL accept at most 5 enquiry submissions per rolling 60-minute window from a single client address, and IF a further submission arrives within that window, THEN THE NGF_Site SHALL reject it, SHALL create no Lead, SHALL present a message stating the whole number of minutes remaining until a submission will be accepted again, and SHALL retain every entered value.
10. WHERE a submission matches a spam heuristic other than the anti-spam field and timing checks, THE NGF_Site SHALL store the Lead with a spam indicator rather than discarding it.
11. THE NGF_Site SHALL validate any image attached to an enquiry with the same checks applied to admin image uploads, SHALL make it visible only within the leads admin, and SHALL NOT render it on any public surface.
12. THE NGF_Site SHALL present in the leads admin each Lead's name, phone, referenced product, message, server-recorded submission date and time, originating page, and Lead_Status.
13. THE NGF_Site SHALL allow an Admin_Operator to search leads by text and to filter leads by Lead_Status and by date range.
14. THE NGF_Site SHALL allow an Admin_Operator to set a Lead's status to any of NEW, CONTACTED, FOLLOW_UP, CONVERTED, or CLOSED, and to attach a note.
15. THE NGF_Site SHALL offer from the leads admin a one-action WhatsApp link and a one-action call link to the lead's own number, and an export of the filtered leads.
16. THE NGF_Site SHALL store Leads outside the Content_Repository and SHALL NOT commit any Lead data to version control.
17. IF an enquiry submission references a product identifier that the server resolves to no product whose Product_Status is PUBLISHED or OUT_OF_STOCK, THEN THE NGF_Site SHALL reject the submission, SHALL create no Lead, SHALL present a message indicating that the referenced product is no longer available together with a control leading to the Catalogue, and SHALL retain every other entered value.
18. IF an image attached to an enquiry fails any of the admin image upload checks, THEN THE NGF_Site SHALL reject the submission, SHALL create no Lead, SHALL retain no part of the rejected image, SHALL present a field-level message naming the image field and stating which limit the file exceeded or that the file type is not accepted, and SHALL retain every other entered value.
19. IF the NGF_Site cannot store a Lead that has passed every validation, anti-spam, and rate-limit check, THEN THE NGF_Site SHALL present a message indicating that the enquiry was not recorded, SHALL present the WhatsApp and Call controls for both business numbers as the direct alternative, and SHALL retain every entered value other than the attached image.

### Requirement 7: Homepage Composition

**User Story:** As a prospective customer arriving at the site for the first time, I want a homepage that establishes New Galaxy Furniture as a premium maker and routes me to the right products, so that I can decide to explore or enquire immediately.

#### Acceptance Criteria

1. THE NGF_Site SHALL present the homepage as the fifteen sections animated hero, shop by category, featured products, new arrivals, best sellers, trending, craftsmanship, direct manufacturer, custom furniture, showroom and workshop story, customer reviews, gallery, WhatsApp call-to-action, contact and location, and footer, in that order, and SHALL preserve that relative order among the sections it renders whenever any section is omitted.
2. THE NGF_Site SHALL render the featured, new arrivals, best sellers, and trending sections each with a composition that differs from the other three in at least one observable structural attribute — items per row at a viewport width of 1280 px, item aspect ratio, or scroll axis — such that no two of the four present the same combination of those three attributes, and SHALL NOT render the four as one repeated uniform card grid.
3. THE NGF_Site SHALL render the hero with the brand mark, the positioning line, and exactly the three calls to action Explore Collection, Order or Enquire on WhatsApp, and Call Now, each an operable control of at least 44 px in each dimension, and SHALL render no fourth call to action in the hero.
4. THE NGF_Site SHALL render exactly one responsive optimised image as the hero's largest content element, SHALL emit that image's intrinsic width and height, and SHALL render no other hero media occupying a larger painted area than that image at any viewport width from 320 px to 1920 px.
5. THE NGF_Site SHALL NOT include background video on the homepage or on any other public page.
6. THE NGF_Site SHALL render the hero's layered animated illustration assembly across at most three parallax depth planes using only transform and opacity changes, and SHALL animate no other property on those planes.
7. WHEN an Admin_Operator changes a homepage section's copy in the admin application, THE NGF_Site SHALL render the changed copy on the public homepage after the next Publish_Deploy completes, without any code change and with the section's position in the order of criterion 1 unchanged.
8. THE NGF_Site SHALL source the positioning line from site settings, accepting a value of 1 to 120 characters, so that an Admin_Operator can change it without a code change.
9. WHERE a homepage product section among featured products, new arrivals, best sellers, and trending resolves to zero Catalogue products, THE NGF_Site SHALL omit that section's heading, container, and controls entirely, SHALL leave no residual vertical gap where it would have appeared, and SHALL NOT substitute products drawn from another of those sections.
10. WHERE the craftsmanship, direct manufacturer, or showroom and workshop copy has not been supplied by the operator, THE NGF_Site SHALL render in that section a placeholder that is visually distinguished from supplied copy and labelled as awaiting content, SHALL include that section's unsupplied content key in the admin content checklist, and SHALL NOT state any manufacturing process, timeline, capability, or business achievement that the operator has not supplied.
11. WHILE Reduced_Motion is set, THE NGF_Site SHALL render the hero's layered illustration assembly in its final drawn state on first paint, SHALL hold all parallax depth planes at their neutral position for the whole visit, and SHALL keep the brand mark, the positioning line, and all three hero calls to action fully visible and operable.
12. WHILE the hero image has not finished loading, THE NGF_Site SHALL render that image's LQIP in the image slot at the image's final layout dimensions, SHALL keep the brand mark, the positioning line, and all three hero calls to action rendered and operable, and SHALL introduce no layout shift when the image completes loading.
13. WHEN an Admin_Operator disables a homepage section in the admin application, THE NGF_Site SHALL omit that section from the public homepage after the next Publish_Deploy completes, and WHEN an Admin_Operator re-enables it, THE NGF_Site SHALL restore it after the next Publish_Deploy at its position in the order of criterion 1.

### Requirement 8: Supporting Public Pages and Placeholder Content

**User Story:** As a prospective customer, I want pages that explain the business, its work, and its terms, so that I can trust the maker before I enquire.

#### Acceptance Criteria

1. THE NGF_Site SHALL serve the pages `/custom-furniture`, `/about`, `/workshop`, `/gallery`, `/reviews`, `/contact`, and `/faq`.
2. THE NGF_Site SHALL serve the policy pages `/privacy`, `/terms`, `/shipping`, `/returns`, and `/warranty`.
3. WHERE a policy page's content has not been finalised by the operator, THE NGF_Site SHALL render a professionally structured placeholder carrying a visible notice that the policy is being finalised and directing the visitor to contact the business for current terms.
4. THE NGF_Site SHALL NOT state a delivery timeframe, a return window, a cancellation term, or a warranty term that the operator has not supplied.
5. THE NGF_Site SHALL render on `/contact` the business location details, both business numbers, and a map link, each only where the operator has supplied it.
6. THE NGF_Site SHALL render on `/reviews` and in the homepage reviews section only reviews whose status is published.
7. THE NGF_Site SHALL present the custom furniture page with the Custom Furniture Enquiry form and both conversion controls.
8. THE NGF_Site SHALL maintain a list of content keys still awaiting real copy and SHALL present that list as a checklist in the admin application.

### Requirement 9: Site Navigation

**User Story:** As a prospective customer on any device, I want navigation that reaches any category or the enquiry channels in one or two actions, so that I never have to hunt for what I need.

#### Acceptance Criteria

1. WHILE the viewport is 1024 px or wider, THE NGF_Site SHALL present a header containing the brand mark and the destinations Sofas, Beds, Dining, Chairs, Tables, Storage, Custom Furniture, Collection, and Contact, plus a search trigger and a WhatsApp call-to-action.
2. THE NGF_Site SHALL present at most nine top-level header destinations, grouping additional category destinations into a dropdown panel.
3. WHILE the page is scrolled to the top of the homepage, THE NGF_Site SHALL render the header transparent over the hero, and WHEN the visitor scrolls down, THE NGF_Site SHALL transition the header to a solid dark surface by changing background and opacity only.
4. WHILE the viewport is narrower than 1024 px, THE NGF_Site SHALL present a header containing the brand mark, a search control, a menu control, and a persistent enquiry affordance.
5. WHEN a visitor opens the mobile menu, THE NGF_Site SHALL display a full-height panel, confine keyboard focus to that panel, and prevent the page behind it from scrolling.
6. WHEN a visitor presses Escape while the mobile menu is open, THE NGF_Site SHALL close the panel and return focus to the control that opened it.
7. THE NGF_Site SHALL present the same category destinations in the footer together with both business numbers and the supporting pages.

### Requirement 10: Admin Authentication and Authorization

**User Story:** As an admin operator, I want the admin system reachable only by me with credentials, so that no one else can alter what customers see.

#### Acceptance Criteria

1. WHEN an unauthenticated request is made to any admin route or admin API endpoint, THE NGF_Site SHALL refuse the request and SHALL perform no data change.
2. WHEN an unauthenticated visitor requests an admin page, THE NGF_Site SHALL redirect to the login page carrying the originally requested path, and WHEN authentication succeeds, THE NGF_Site SHALL return the operator to that path.
3. WHEN an Admin_Operator submits a correct email and password, THE NGF_Site SHALL establish a session identified by an opaque server-side record and SHALL set that identifier in a cookie marked HttpOnly, Secure, and SameSite=Lax.
4. THE NGF_Site SHALL store admin credentials only as a salted key-derivation hash, SHALL NOT store or log any password in plaintext, and SHALL NOT include any credential in the Content_Repository.
5. IF a login attempt supplies an unknown email or an incorrect password, THEN THE NGF_Site SHALL respond with one identical failure result for both cases and SHALL NOT indicate whether the email exists.
6. WHEN an Admin_Operator logs out, THE NGF_Site SHALL delete the server-side session record and clear the session cookie, such that the previous cookie value is no longer accepted.
7. THE NGF_Site SHALL end a session 12 hours after it was created and SHALL end a session after 2 hours without activity.
8. WHEN a state-changing admin request arrives without the session's matching anti-CSRF token in the request header, THE NGF_Site SHALL refuse the request and SHALL perform no data change.
9. WHEN a state-changing admin request arrives with an origin that does not match the deployment origin, THE NGF_Site SHALL refuse the request before performing any other work.
10. IF 5 login attempts for one email address fail within 15 minutes, THEN THE NGF_Site SHALL lock further attempts for that address for progressively longer periods of 1, 5, 15, and 60 minutes.
11. THE NGF_Site SHALL accept at most 20 login attempts per 15 minutes from a single client address.
12. THE NGF_Site SHALL accept at most 120 admin API requests per minute per session.
13. THE NGF_Site SHALL support the roles owner, editor, and viewer, and SHALL ship with exactly one owner account created outside the repository.
14. THE NGF_Site SHALL determine authorization for every admin operation on the server from the session's role, regardless of any capability the browser presents.
15. THE NGF_Site SHALL require a declared permission for every admin API endpoint.
16. THE NGF_Site SHALL grant an Admin_Operator holding the viewer role no permission that creates, changes, publishes, or deletes any record.
17. WHERE an Admin_Operator lacks the permission for an action, THE NGF_Site SHALL hide the corresponding control in the admin interface in addition to refusing the request on the server.
18. THE NGF_Site SHALL allow additional admin accounts and roles to be added without changing the stored data structures.

### Requirement 11: Admin Dashboard and Navigation

**User Story:** As an admin operator, I want one dashboard that shows the state of my catalogue and enquiries and links to every management area, so that I can run the site without technical help.

#### Acceptance Criteria

1. THE NGF_Site SHALL provide the admin areas Dashboard, Products, Add Product, AI Product Assistant, Categories, Reviews, Leads, Homepage, Content, Analytics, and Settings, each reachable from persistent admin navigation.
2. THE NGF_Site SHALL present on the Dashboard the counts of published products, drafts, products awaiting review, out-of-stock products, and new leads.
3. THE NGF_Site SHALL derive every Dashboard figure from stored records and SHALL NOT display any sample, illustrative, or placeholder number.
4. WHERE a Dashboard metric has no underlying records, THE NGF_Site SHALL present an explicit empty state rather than a zero presented as a result.
5. THE NGF_Site SHALL exclude every admin page from search engine indexing.
6. THE NGF_Site SHALL present the Dashboard's recent activity from the recorded content change history.

### Requirement 12: Admin Product Management

**User Story:** As an admin operator, I want to create, edit, duplicate, publish, and remove products from the admin application, so that I control the catalogue without touching code.

#### Acceptance Criteria

1. THE NGF_Site SHALL allow an authorized Admin_Operator to create a product, edit a product, duplicate a product, and delete a product.
2. THE NGF_Site SHALL present the product list with filtering by Product_Status and category and searching by text.
3. WHEN an Admin_Operator saves an incomplete product, THE NGF_Site SHALL store it as a Draft without applying the Publish_Gate.
4. WHEN an Admin_Operator saves a Draft, THE NGF_Site SHALL make the saved values available for preview within one second of the save completing, without waiting for a Publish_Deploy.
5. WHEN an Admin_Operator duplicates a product, THE NGF_Site SHALL create a new product with a newly generated identifier, a newly generated SKU, a slug distinct from every existing slug, and Product_Status DRAFT.
6. WHEN an Admin_Operator duplicates a product, THE NGF_Site SHALL leave the source product's stored values entirely unchanged.
7. WHEN an Admin_Operator requests deletion of a product, THE NGF_Site SHALL require an explicit confirmation identifying that product before removing it.
8. THE NGF_Site SHALL allow an Admin_Operator to set the featured, trending, best seller, and new arrival flags and the stock status on any product.
9. WHEN an Admin_Operator opens Preview Product for a product, THE NGF_Site SHALL render that product using the same components that render the public product detail page, using the current draft values.
10. THE NGF_Site SHALL exclude every preview page from search engine indexing.
11. WHEN an Admin_Operator renames a product in a way that changes its slug, THE NGF_Site SHALL require explicit confirmation and SHALL redirect the previous URL to the new URL with HTTP status 301.
12. THE NGF_Site SHALL NOT change an existing product's slug without an explicit operator confirmation.
13. WHEN two admin sessions edit the same product concurrently, THE NGF_Site SHALL serialise the writes so that the second write observes the first.

### Requirement 13: Manual Product Creator

**User Story:** As an admin operator, I want one complete product form organised into clear groups, so that I can enter a product's full detail in a single pass without AI assistance.

#### Acceptance Criteria

1. THE NGF_Site SHALL present the product creation form in the groups Basic Information, Pricing, Product, Inventory, Marketing, SEO, and Images.
2. THE NGF_Site SHALL collect in Basic Information the product name, category, subcategory, description, and short description.
3. THE NGF_Site SHALL collect in Pricing the price, the price-on-enquiry setting, the original price, and the resulting discount.
4. THE NGF_Site SHALL collect in Product the material, colour, available colours, dimensions, size, variants, customization information, and delivery information.
5. THE NGF_Site SHALL collect in Inventory the stock status and the made-to-order setting.
6. THE NGF_Site SHALL collect in Marketing the featured, trending, best seller, and new arrival flags, the tags, and the related products.
7. THE NGF_Site SHALL collect in SEO the SEO title, SEO description, and keywords.
8. THE NGF_Site SHALL accept at least 20 images per product, so that a typical set of about 10 images is never constrained by the limit.
9. WHEN an Admin_Operator sets an original price that is not greater than the price, THE NGF_Site SHALL reject the value with a field-level message.
10. THE NGF_Site SHALL derive the displayed discount percentage from the price and original price and SHALL NOT accept a discount inconsistent with those two values.
11. WHEN an Admin_Operator marks a product as price-on-enquiry, THE NGF_Site SHALL require the numeric price to be empty.
12. THE NGF_Site SHALL allow an Admin_Operator to complete every product field without invoking the AI Product Assistant.
13. WHEN an Admin_Operator submits the product form, THE NGF_Site SHALL generate the slug and the SKU automatically from the product name and category.

### Requirement 14: Product Lifecycle and Publish Validation

**User Story:** As an admin operator, I want a controlled path from draft to published with completeness checks, so that nothing half-finished or unreviewed can reach customers.

#### Acceptance Criteria

1. THE NGF_Site SHALL support exactly the product statuses DRAFT, REVIEW, PUBLISHED, UNPUBLISHED, and OUT_OF_STOCK.
2. THE NGF_Site SHALL permit a status change only where the target status is declared reachable from the current status, and SHALL refuse a change of a product to its own current status.
3. THE NGF_Site SHALL permit a change to PUBLISHED or OUT_OF_STOCK only from an Admin_Operator holding publish permission.
4. WHEN an Admin_Operator requests publication of a product, THE NGF_Site SHALL apply the Publish_Gate requiring a name, a category, a SKU, a description, a price or the price-on-enquiry setting, at least one image, a stock status, and non-empty alt text on every image.
5. IF a product fails any Publish_Gate check, THEN THE NGF_Site SHALL refuse the publication and SHALL report each failure against the specific field that failed.
6. THE NGF_Site SHALL NOT allow any sequence of status changes to place a product that fails the Publish_Gate into PUBLISHED or OUT_OF_STOCK.
7. WHEN a product's Product_Status is OUT_OF_STOCK, THE NGF_Site SHALL require that product's Stock_Status to be OUT_OF_STOCK, and the converse.
8. WHEN a product is marked made-to-order, THE NGF_Site SHALL require its Stock_Status to be MADE_TO_ORDER.
9. WHEN a product is unpublished or deleted, THE NGF_Site SHALL remove its public detail page, catalogue entries, search entry, and sitemap entry after the next Publish_Deploy.
10. THE NGF_Site SHALL NOT publish any product through an automated, scheduled, or non-interactive path; publication SHALL occur only in response to an authenticated Admin_Operator action.
11. THE NGF_Site SHALL create every AI-assisted product as a Draft and SHALL record which fields originated as AI suggestions.
12. WHEN an Admin_Operator publishes a product, THE NGF_Site SHALL indicate that publishing is in progress and SHALL report the actual deployment outcome rather than reporting success before the change is live.
13. IF the deployment following a publication fails, THEN THE NGF_Site SHALL report the failure to the Admin_Operator and the previously deployed site SHALL continue to serve.
14. THE NGF_Site SHALL reject a product record whose image ordering is not a contiguous sequence beginning at the first position.
15. THE NGF_Site SHALL reject a product record whose designated primary image is not one of that product's own images.

### Requirement 15: Image Upload, Processing, and Delivery

**User Story:** As an admin operator, I want to upload product photographs and have the site serve them fast and safely at every size, so that the catalogue looks premium without slowing pages down.

#### Acceptance Criteria

1. THE NGF_Site SHALL accept image uploads in the formats JPEG, PNG, WebP, and AVIF.
2. THE NGF_Site SHALL reject an upload larger than 12 MB, an upload whose pixel count exceeds 40,000,000, and an upload narrower than 800 px.
3. THE NGF_Site SHALL determine an upload's type from the file's leading bytes and SHALL reject a file whose leading bytes are not an accepted image format, regardless of the declared content type or the filename extension.
4. THE NGF_Site SHALL reject SVG uploads for product imagery.
5. IF an uploaded file cannot be decoded as an image, THEN THE NGF_Site SHALL reject it with a message naming the specific reason.
6. WHEN an upload is accepted, THE NGF_Site SHALL strip the file's embedded metadata, including any location data.
7. THE NGF_Site SHALL derive the stored location of every uploaded image on the server and SHALL NOT use any client-supplied filename or path as a storage location.
8. WHEN an upload is accepted, THE NGF_Site SHALL generate Derivatives at the widths 320, 480, 640, 960, 1280, 1600, and 2000 px, omitting any width greater than the original's width.
9. THE NGF_Site SHALL generate each Derivative width in AVIF and WebP, plus one JPEG fallback, and SHALL serve the most efficient format the requesting browser accepts.
10. THE NGF_Site SHALL record each image's intrinsic width and height and SHALL emit those dimensions on every rendered image so that no image causes layout shift.
11. THE NGF_Site SHALL generate an LQIP for each image and SHALL render it in the image's slot until the image loads.
12. THE NGF_Site SHALL offer no Derivative wider than the original image, and SHALL always offer at least one Derivative for every accepted image.
13. WHILE Derivatives for an uploaded image are still being generated, THE NGF_Site SHALL indicate that state in the admin interface and SHALL continue to serve the accepted original.
14. THE NGF_Site SHALL allow an Admin_Operator to reorder a product's images, to designate the primary image, and to edit each image's alt text.
15. THE NGF_Site SHALL allow an Admin_Operator to accept a suggested alt text or to replace it with their own, and SHALL record which of the two applies.
16. WHEN an Admin_Operator deletes an image, THE NGF_Site SHALL retain the stored file recoverable for 30 days.
17. THE NGF_Site SHALL load eagerly only one image per product card, only the primary image on a product detail page, and only the first six cards in a catalogue grid, deferring every other image until it is needed.
18. IF an image fails to load, THEN THE NGF_Site SHALL render a styled fallback carrying the image's alt text within the reserved slot, without changing the surrounding layout.

### Requirement 16: AI Product Assistant

**User Story:** As an admin operator, I want AI help drafting a product's copy and metadata from a photograph and a few notes, so that listing a product takes minutes instead of an hour, without the machine inventing facts about my business.

#### Acceptance Criteria

1. THE NGF_Site SHALL allow an Admin_Operator to request generated product content from uploaded product images, from typed notes, or from both.
2. WHEN generation succeeds, THE NGF_Site SHALL return a suggested product name, short description, full description, category, subcategory, material, colour, style tags, features, SEO title, SEO description, keywords, per-image alt text, and WhatsApp enquiry text.
3. THE NGF_Site SHALL present every suggested value in the product form pre-filled and editable.
4. THE NGF_Site SHALL mark each suggested value as originating from the AI assistant, and WHEN an Admin_Operator edits a suggested value, THE NGF_Site SHALL record that value's Provenance as admin.
5. WHERE a factual field was not supplied in Admin_Facts, THE NGF_Site SHALL leave that field empty in the returned suggestion and SHALL report that it was left empty.
6. WHERE a factual field was supplied in Admin_Facts, THE NGF_Site SHALL return exactly the operator's value for that field, discarding any differing generated value.
7. THE NGF_Site SHALL treat price, original price, dimensions, size, material, colour, available colours, stock status, made-to-order, delivery information, and customization as factual fields subject to acceptance criteria 5 and 6.
8. THE NGF_Site SHALL remove from generated free text any claim about years in business, certification, award, customer count, employee count, showroom count, delivery-time guarantee, warranty term, market-position superlative, or a price not supplied in Admin_Facts, and SHALL report each removal.
9. WHERE a generated category does not match an existing category, THE NGF_Site SHALL discard it and SHALL report that no category was assigned.
10. THE NGF_Site SHALL truncate every generated value to the maximum length permitted for its field and SHALL remove markup and control characters before the value is stored.
11. THE NGF_Site SHALL NOT allow the generation operation to set a product's status or publication state.
12. IF generation does not complete within 20 seconds, or returns content that cannot be interpreted, or the provider reports an error, THEN THE NGF_Site SHALL report that suggestions are unavailable and SHALL leave the product form fully usable.
13. THE NGF_Site SHALL accept at most 20 generation requests per hour per session.
14. THE NGF_Site SHALL NOT disclose the AI provider credential, the provider's raw error content, or the provider's internal identifiers to the browser.
15. THE NGF_Site SHALL allow an additional AI provider to be configured without changing the admin interface or the generation contract.

### Requirement 17: Git-Backed Content Workflow

**User Story:** As a developer maintaining the site, I want all structured content to live as validated files in the repository with a reviewable history, so that every content change is traceable and reversible.

#### Acceptance Criteria

1. THE NGF_Site SHALL store products, categories, reviews, and site settings as structured JSON files under `/data` in the Content_Repository, and SHALL treat those files as the source of truth for published content.
2. THE NGF_Site SHALL hold the credential used to write to the Content_Repository only on the server and SHALL NOT transmit it to any browser.
3. THE NGF_Site SHALL derive the target file path for every content write on the server from the stored record, and SHALL NOT accept a file path from the browser.
4. THE NGF_Site SHALL write only to paths in the Path_Allowlist, which contains product, category, review, and site configuration files under `/data`, and SHALL refuse every other path.
5. WHEN a candidate path contains a parent-directory segment, a leading separator, a backslash, a null byte, or a percent-encoded form of any of these, THE NGF_Site SHALL refuse the write.
6. THE NGF_Site SHALL resolve every legitimate content path for a valid slug without refusal, and SHALL return a refusal rather than raising an error for any input whatsoever.
7. THE NGF_Site SHALL validate every content payload against its schema on the server before any write, regardless of any validation the browser performed.
8. IF a content payload fails schema validation, THEN THE NGF_Site SHALL refuse the write and SHALL report each failure against the field that failed.
9. WHEN the NGF_Site writes a content file, THE NGF_Site SHALL preserve any field present in the stored file that its schema does not recognise.
10. WHEN a content file has changed since the Admin_Operator loaded it, THE NGF_Site SHALL refuse the write, SHALL report the conflict, and SHALL present the current stored values so the operator can choose per field.
11. THE NGF_Site SHALL NOT overwrite a changed content file with the operator's stale values without an explicit operator decision.
12. WHEN the NGF_Site commits a content change, THE NGF_Site SHALL record in the commit message the action performed, the affected product's name and SKU, the status transition, and the acting Admin_Operator.
13. THE NGF_Site SHALL restrict every content commit to files under `/data` and SHALL NOT modify application source, configuration, dependency, or workflow files.
14. WHEN a content change alters only draft or in-review content, THE NGF_Site SHALL commit the change without triggering a Publish_Deploy.
15. WHEN a content change alters published state, THE NGF_Site SHALL trigger a Publish_Deploy.
16. WHEN a content change affects more than one file, THE NGF_Site SHALL apply all of those file changes as a single commit.
17. IF a write to the Content_Repository fails, THEN THE NGF_Site SHALL retain the operator's unsaved values, report the failure, and offer a retry.
18. THE NGF_Site SHALL NOT store image binaries in the Content_Repository.
19. THE NGF_Site SHALL make a product's slug unique across the catalogue at the point of creation.

### Requirement 18: Category and Review Management

**User Story:** As an admin operator, I want to manage the categories customers browse and the reviews they read, so that the catalogue structure and social proof stay current and truthful.

#### Acceptance Criteria

1. THE NGF_Site SHALL provide the nine categories `sofas`, `beds`, `dining-tables`, `dining-chairs`, `accent-chairs`, `coffee-side-tables`, `storage-display`, `office`, and `outdoor` on first deployment.
2. THE NGF_Site SHALL allow an authorized Admin_Operator to create, edit, reorder, publish, unpublish, and delete a category.
3. WHEN a new category is added, THE NGF_Site SHALL make its listing route, navigation entry, and filter option available after the next Publish_Deploy without a code change.
4. IF an Admin_Operator attempts to delete a category that products are assigned to, THEN THE NGF_Site SHALL refuse the deletion and SHALL report the number of assigned products.
5. THE NGF_Site SHALL require every product's category to correspond to an existing category.
6. THE NGF_Site SHALL allow an authorized Admin_Operator to add, edit, delete, publish, unpublish, feature, and reorder a customer review.
7. THE NGF_Site SHALL collect for each review the customer name, a rating from 1 to 5, the review text, an optional customer photograph, an optional product photograph, an optional video, an optional linked product, and an optional date.
8. THE NGF_Site SHALL NOT display a review on any public surface until an Admin_Operator has published it.
9. THE NGF_Site SHALL NOT generate, infer, or supply any review content, rating, or customer name.
10. THE NGF_Site SHALL NOT emit aggregate rating structured data for a product unless published reviews are linked to that specific product.

### Requirement 19: Site Settings and Business Information

**User Story:** As an admin operator, I want every piece of business information the site displays to be editable by me, so that nothing is hard-coded and nothing is invented.

#### Acceptance Criteria

1. THE NGF_Site SHALL allow an authorized Admin_Operator to edit the business name, the brand mark, the WhatsApp numbers, the phone numbers, the location details, the service area, the social profile links, the SEO defaults, the homepage content, and the contact information.
2. THE NGF_Site SHALL store the WhatsApp numbers and phone numbers as lists, and SHALL accept additional numbers without a change to the stored structure.
3. THE NGF_Site SHALL ship with the WhatsApp and phone numbers +91 95134 43606 and +91 81470 83703, each labelled for orders and enquiries.
4. WHERE the brand mark file has not been supplied, THE NGF_Site SHALL render a typographic wordmark fallback in the header, footer, hero, social preview image, and admin interface.
5. WHEN the brand mark file is supplied and the corresponding setting is set, THE NGF_Site SHALL use it in place of the wordmark fallback without any code change.
6. WHERE a location detail, opening hours, price range, or social profile link has not been supplied, THE NGF_Site SHALL omit it from every public surface and from structured data rather than displaying a guessed value.
7. THE NGF_Site SHALL accept additional service locations and additional admin accounts without a change to the stored structures.
8. THE NGF_Site SHALL validate every stored number as a well-formed international telephone number.

### Requirement 20: Analytics and Honest Reporting

**User Story:** As an admin operator, I want to know which products and categories draw interest and how often visitors reach out, so that I can decide what to make and promote, without being misled about what the numbers mean.

#### Acceptance Criteria

1. THE NGF_Site SHALL record the events product view, category view, WhatsApp click, call click, search, and enquiry submission.
2. THE NGF_Site SHALL store recorded events only as daily aggregate counts and SHALL NOT store any per-visitor identifier, cookie identifier, device fingerprint, or retained client address for analytics.
3. THE NGF_Site SHALL validate every submitted event batch on the server, rejecting unknown event types, batches larger than 20 events, and timestamps more than 10 minutes from the server's time.
4. THE NGF_Site SHALL accept at most 200 event submissions per minute from a single client address.
5. THE NGF_Site SHALL present in the admin Analytics area the most viewed products, the most viewed categories, WhatsApp and call click counts, the most frequent searches, searches that returned no results, and enquiry counts, each over a selectable date range.
6. THE NGF_Site SHALL label every presented figure as either measured or operator-set.
7. THE NGF_Site SHALL state in the Analytics area that click counts record the act of opening WhatsApp or a phone dialler and cannot establish whether a conversation or an order followed.
8. THE NGF_Site SHALL state in the Analytics area that recorded counts are a lower bound because some visitors block or drop event reporting.
9. THE NGF_Site SHALL NOT present a fabricated, sample, illustrative, or extrapolated figure anywhere in the Analytics area.
10. WHERE no events have been recorded for a selected range, THE NGF_Site SHALL present an explicit empty state stating that data accrues after launch.
11. THE NGF_Site SHALL make measured view counts available to the Most Viewed sort option, dated to the measurement snapshot.
12. THE NGF_Site SHALL record conversion outcome only from operator-set Lead_Status values and SHALL NOT infer a conversion from any visitor event.

### Requirement 21: Motion and Visual Design System

**User Story:** As a prospective customer, I want the site to feel like a premium furniture maker's own showroom, with motion that adds meaning rather than noise, so that I trust the craftsmanship before I see it in person.

#### Acceptance Criteria

1. THE NGF_Site SHALL use exactly the palette Obsidian #171513, Espresso #3B2A21, Walnut #6B4A36, Champagne Gold #B88A45, Ivory #F8F2EA, Cream #EFE4D7, Taupe #CBBBA9, and White #FFFFFF.
2. THE NGF_Site SHALL restrict Champagne Gold to at most one element per viewport height of scroll and SHALL NOT use it for large fills or body text.
3. THE NGF_Site SHALL meet WCAG AA contrast for every text and interface colour pairing it uses.
4. THE NGF_Site SHALL render display headings in a serif family and body, interface, and admin text in a sans-serif family.
5. THE NGF_Site SHALL provide the nine animated 2D illustration primitives generic furniture line, chair, sofa, bed, table, room composition, craftsmanship detail lines, furniture assembly, and category illustration, each authored as inline vector graphics with no raster asset and no external animation runtime.
6. THE NGF_Site SHALL support scroll-triggered reveals, parallax depth layers, text reveals, image mask reveals, section transitions, hover micro-interactions, animated directional arrows, animated decorative rules, subtle continuous drift, scroll-linked transforms, and a before-and-after room comparison control.
7. THE NGF_Site SHALL apply interaction feedback over 180 ms, structural changes over 320 ms, section and product reveals over 640 ms, and narrative sequences over at most 1000 ms.
8. THE NGF_Site SHALL animate only transform, opacity, clip-path, and stroke-dash properties, and SHALL NOT animate width, height, top, left, margin, blur, or shadow.
9. THE NGF_Site SHALL animate at most 12 elements simultaneously on any public page.
10. THE NGF_Site SHALL NOT run an animation frame loop while its target element is off-screen or while the browser tab is hidden.
11. WHILE Reduced_Motion is set, THE NGF_Site SHALL render every illustration primitive in its final drawn state immediately, SHALL flatten every parallax layer to its neutral position, SHALL suppress every continuous animation, and SHALL keep every control fully operable.
12. WHILE Reduced_Motion is set, THE NGF_Site SHALL retain focus indication, menu opening and closing, gallery changes, and loading indication at 180 ms so that the interface still reads as responsive.
13. THE NGF_Site SHALL provide a visitor-facing control that suppresses non-essential motion and SHALL retain that choice on the visitor's device across visits.
14. THE NGF_Site SHALL NOT delay the largest content element of any page behind an animation sequence.
15. THE NGF_Site SHALL limit motion-related client script to 14 KB compressed and the combined inline illustration markup to 18 KB, with at most four illustration primitives per page.

### Requirement 22: Performance

**User Story:** As a mobile visitor on a mid-range phone and a mobile network, I want pages to appear and respond immediately, so that browsing furniture never feels like waiting.

#### Acceptance Criteria

1. THE NGF_Site SHALL achieve on a throttled mobile connection a Largest Contentful Paint of 2.0 seconds or less, an Interaction to Next Paint of 150 ms or less, a Cumulative Layout Shift of 0.03 or less, and an edge-served Time to First Byte of 200 ms or less.
2. IF Largest Contentful Paint exceeds 2.5 seconds, Interaction to Next Paint exceeds 200 ms, Cumulative Layout Shift exceeds 0.05, or Time to First Byte exceeds 500 ms, THEN the release SHALL be treated as failing.
3. THE NGF_Site SHALL score at least 95 for mobile Performance, 100 for Accessibility, 100 for SEO, and at least 95 for Best Practices in automated auditing.
4. THE NGF_Site SHALL keep compressed client script within 45 KB on the homepage, 70 KB on the catalogue route excluding the deferred search index, 55 KB on a product detail page, 20 KB on a static content page, and 220 KB in the admin application.
5. THE NGF_Site SHALL keep compressed stylesheet payload within 24 KB per public route and total font payload within 55 KB.
6. THE NGF_Site SHALL keep total initial transfer within 320 KB on the homepage, 320 KB on the catalogue route, 340 KB on a product detail page, and 160 KB on a static content page.
7. THE NGF_Site SHALL keep the deferred search index within 60 KB compressed and SHALL NOT include it in any page's initial payload.
8. WHEN a visitor first indicates search intent, THE NGF_Site SHALL load the search index at that point rather than on initial page load.
9. THE NGF_Site SHALL serve every image through a responsive source set with format negotiation and SHALL NOT serve a full-resolution image to a product card.
10. THE NGF_Site SHALL defer loading of every image outside the initial viewport and SHALL preload at most one image per page.
11. THE NGF_Site SHALL split client code per route and SHALL load the gallery fullscreen view, the before-and-after control, the search index, and each admin area only when required.
12. THE NGF_Site SHALL NOT load any third-party script on the critical rendering path of any public page.
13. THE NGF_Site SHALL render no more than 1,500 document nodes on any public page.
14. IF any asset budget in acceptance criteria 4 through 7 is exceeded, THEN the release SHALL be treated as failing.

### Requirement 23: SEO and Structured Data

**User Story:** As a search engine crawler, I want each page to declare accurate, unique, and complete metadata, so that New Galaxy Furniture's products can be indexed and presented correctly.

#### Acceptance Criteria

1. THE NGF_Site SHALL emit on every public page a unique title of at most 60 characters and a unique description of at most 155 characters.
2. THE NGF_Site SHALL emit on every public page an absolute canonical URL derived from a single configured site URL value.
3. THE NGF_Site SHALL NOT contain a hard-coded production hostname in its application source.
4. THE NGF_Site SHALL emit social preview metadata including type, title, description, image, and card type on every public page.
5. WHERE a product has no explicit SEO title, THE NGF_Site SHALL derive one from the product name, category, and configured site title suffix.
6. WHERE a product has no explicit SEO description, THE NGF_Site SHALL derive one from the short description or from the description truncated at a word boundary.
7. THE NGF_Site SHALL emit Product structured data on every product detail page including name, SKU, images as absolute URLs, description, brand, material, colour, and availability derived from the product's stock status.
8. WHERE a product is in the Price_On_Enquiry state, THE NGF_Site SHALL omit the offer block from its structured data rather than emitting any price.
9. THE NGF_Site SHALL emit breadcrumb structured data matching the visible breadcrumb trail on product and category pages.
10. THE NGF_Site SHALL emit local business structured data on the homepage and the contact page containing only fields the operator has supplied, omitting opening hours, price range, founding date, and coordinates until supplied.
11. THE NGF_Site SHALL emit a site search action on the homepage and item list structured data on category pages.
12. THE NGF_Site SHALL use clean URLs containing no numeric identifier or query parameter for product and category pages.
13. THE NGF_Site SHALL generate `sitemap.xml` at build listing every public static page, every Catalogue product, and every published category, each with a last-modified date.
14. THE NGF_Site SHALL generate `robots.txt` disallowing the admin area, the API routes, and the largest image derivatives, and referencing the sitemap.
15. THE NGF_Site SHALL exclude every Draft, preview, and admin page from the sitemap and SHALL mark them as not indexable.
16. WHEN a request arrives at a non-canonical trailing-slash form of a public URL, THE NGF_Site SHALL redirect to the canonical form with HTTP status 301.
17. THE NGF_Site SHALL carry location signals in genuine page content about being a Bengaluru manufacturer serving Karnataka, and SHALL keep any single target phrase within 2% keyword density on any page.
18. THE NGF_Site SHALL NOT emit a metadata value, structured data field, or page content claim that the operator has not supplied.

### Requirement 24: Responsive Layout and Accessibility

**User Story:** As a mobile visitor and as a visitor using assistive technology, I want every page to be usable on my device and with my input method, so that nothing on the site is closed to me.

#### Acceptance Criteria

1. THE NGF_Site SHALL render every page without horizontal overflow, without overlapping content in any interactive region, and without a clipped image, at viewport widths 320, 375, 390, 414, 768, 1024, 1280, 1440, and 1920 px.
2. THE NGF_Site SHALL present a single-column editorial layout, swipeable galleries, horizontally scrolling product rails, and filters in a bottom sheet on viewports narrower than 768 px.
3. THE NGF_Site SHALL size every interactive target at 44 px or greater in each dimension on touch devices.
4. THE NGF_Site SHALL present exactly one first-level heading per page with no skipped heading levels, using semantic document landmarks.
5. THE NGF_Site SHALL make every interactive element operable by keyboard alone, including the search suggestion list, the gallery, the filter sheet, the mobile menu, and every admin table.
6. THE NGF_Site SHALL render a visible focus indicator on every focusable element and SHALL NOT remove focus indication.
7. WHEN a modal or panel opens, THE NGF_Site SHALL confine keyboard focus within it, and WHEN it closes, THE NGF_Site SHALL return focus to the element that opened it.
8. THE NGF_Site SHALL associate a label with every form control and SHALL associate each validation message with its control so assistive technology announces it.
9. WHEN a form control fails validation, THE NGF_Site SHALL mark that control as invalid in a way assistive technology reports.
10. THE NGF_Site SHALL require descriptive alt text on every product image before publication and SHALL mark decorative illustrations as hidden from assistive technology.
11. THE NGF_Site SHALL announce search suggestion result counts through a polite live region.
12. THE NGF_Site SHALL provide a skip-to-content link as the first focusable element on every page.
13. THE NGF_Site SHALL pass automated accessibility auditing with no violations on every public page and every admin page.

### Requirement 25: Security

**User Story:** As a business owner, I want the site and its admin system hardened, so that no one can deface the catalogue, steal enquiry data, or extract a credential.

#### Acceptance Criteria

1. THE NGF_Site SHALL validate every request payload against a schema on the server before acting on it.
2. THE NGF_Site SHALL escape or remove markup from every value originating from a visitor or an Admin_Operator before rendering it into a page, such that no rendered output contains executable script, an event handler attribute, or a script URL scheme.
3. THE NGF_Site SHALL parameterise every database query and SHALL NOT construct a query from unvalidated input.
4. THE NGF_Site SHALL refuse every state-changing request that lacks a valid session, a matching anti-CSRF token, and a matching request origin.
5. THE NGF_Site SHALL refuse every write whose resolved target path is not in the Path_Allowlist.
6. THE NGF_Site SHALL apply the upload validation in Requirement 15 to every uploaded file, including files attached to public enquiry forms.
7. THE NGF_Site SHALL store enquiry-form image uploads separately from public product imagery and SHALL NOT serve them from any public surface.
8. THE NGF_Site SHALL apply a rate limit to login, admin API, image upload, AI generation, enquiry submission, and event submission endpoints.
9. THE NGF_Site SHALL emit on every response a strict transport security header, a content type options header, a referrer policy header, a frame denial header, a permissions policy denying camera, microphone, and geolocation, and a content security policy restricting script, style, image, font, frame, object, and form destinations to the site's own origin and the declared messaging endpoint.
10. THE NGF_Site SHALL produce zero content security policy violations on every public page.
11. THE NGF_Site SHALL set the session cookie with the HttpOnly, Secure, and SameSite attributes.
12. THE NGF_Site SHALL NOT include the Content_Repository credential, the AI provider credential, the session secret, or any datastore credential in any file served to a browser.
13. THE NGF_Site SHALL expose to the browser only the configured site URL, the WhatsApp numbers, and the phone numbers as public configuration values.
14. IF an internal operation fails, THEN THE NGF_Site SHALL return a stable error code and a message safe to display, and SHALL NOT return a stack trace, a file path, an upstream provider response body, or any credential.
15. THE NGF_Site SHALL record failure detail in server-side logs with credentials removed.
16. THE NGF_Site SHALL verify a submitted password against its stored hash such that only the exact password verifies, and SHALL NOT store the password within the stored hash value.

### Requirement 26: Error Handling, Loading, and Empty States

**User Story:** As a prospective customer and as an admin operator, I want the site to tell me plainly what happened and what to do next when something fails, so that I never lose work or hit a dead end.

#### Acceptance Criteria

1. IF a requested product is not published, THEN THE NGF_Site SHALL respond with HTTP status 404 and offer the relevant category, search, and a WhatsApp enquiry.
2. IF a network failure interrupts an enquiry submission, THEN THE NGF_Site SHALL retain every entered value, offer a retry, and offer a WhatsApp or call alternative.
3. IF an Admin_Operator's session has expired, THEN THE NGF_Site SHALL redirect to login carrying the intended destination and SHALL return the operator there after authentication.
4. IF a write to the Content_Repository fails, THEN THE NGF_Site SHALL report that the change was not saved to the repository, SHALL confirm the operator's values are retained, and SHALL offer a retry.
5. IF a content write conflicts with a concurrent change, THEN THE NGF_Site SHALL present the differing values field by field and SHALL require the operator to choose.
6. IF the deployment following a publication fails, THEN THE NGF_Site SHALL report that the content was committed but the site build failed, with a reference to the failed build.
7. IF AI generation fails, THEN THE NGF_Site SHALL report that suggestions are unavailable and SHALL leave the form usable.
8. IF an upload is rejected, THEN THE NGF_Site SHALL name the specific reason for that file and SHALL leave every other file in the batch unaffected.
9. IF a form submission fails validation, THEN THE NGF_Site SHALL report each failure against its own field and SHALL NOT clear any other entered value.
10. IF a rate limit is reached, THEN THE NGF_Site SHALL state that too many attempts were made and when the next attempt is possible.
11. IF a content file fails schema validation during a build, THEN the build SHALL fail before deployment, the failure SHALL name the file and field, and the previously deployed site SHALL continue to serve.
12. WHILE content is loading, THE NGF_Site SHALL display a placeholder shaped like the expected content and SHALL NOT display a blank page.
13. WHILE Reduced_Motion is set, THE NGF_Site SHALL display loading placeholders without animation.
14. THE NGF_Site SHALL present a designed empty state with a suggested next action for no products, no search results, no filter matches, no reviews, no leads, no images, and no analytics data.
15. THE NGF_Site SHALL NOT disclose an internal identifier, file path, stack trace, or upstream error content in any message shown to a visitor or an Admin_Operator.

### Requirement 27: Developer Product-Addition Workflow

**User Story:** As a developer working with Kiro, I want adding a product to be a single command that touches exactly one content file, so that catalogue growth never requires frontend changes or manual wiring.

#### Acceptance Criteria

1. THE NGF_Site SHALL provide a command-line operation that creates a product from supplied name, category, price, material, dimensions, colours, images, and status.
2. WHEN the command completes successfully, THE NGF_Site SHALL have created or modified exactly one product content file and no application source file.
3. WHEN the command runs, THE NGF_Site SHALL verify that the supplied category exists, and IF it does not, THEN THE NGF_Site SHALL fail and list the valid category slugs without creating a category.
4. WHEN the command runs, THE NGF_Site SHALL generate a slug that is unique across existing products and a SKU that is unique across existing products, using the same generation logic the admin application uses.
5. WHEN the command runs, THE NGF_Site SHALL process supplied images through the same validation and Derivative generation used by admin uploads and SHALL record each image's intrinsic dimensions.
6. WHEN the command runs, THE NGF_Site SHALL validate the assembled product against the product schema, and additionally against the Publish_Gate where a published status was requested.
7. WHEN the command runs, THE NGF_Site SHALL generate the product's SEO title and description where they were not supplied.
8. WHEN the command runs, THE NGF_Site SHALL verify that the product's WhatsApp enquiry link is generated and decodes back to the intended message.
9. IF any validation performed by the command fails, THEN THE NGF_Site SHALL write no content file and SHALL report the failing field.
10. WHEN a new product content file is added, THE NGF_Site SHALL make that product's detail page, category listing entry, search index entry, sitemap entry, and structured data available after the next build with no further edits.
11. THE NGF_Site SHALL produce byte-compatible product files from the command-line operation, the admin product creator, and the AI-assisted creator.
12. THE NGF_Site SHALL provide repeatable commands that check types, lint, run unit and property tests, build, and scan the build output for credential patterns.

### Requirement 28: Deployment and Documentation

**User Story:** As a developer maintaining the site, I want deployment automated from the repository with secrets held server-side and the project documented, so that anyone can operate and hand over the system safely.

#### Acceptance Criteria

1. THE NGF_Site SHALL deploy automatically from the connected repository, with the default branch serving production.
2. WHEN a pull request is opened, THE NGF_Site SHALL produce a preview deployment marked as not indexable and using a site URL distinct from production.
3. THE NGF_Site SHALL run, in order, content schema validation, type checking, linting, unit and property tests, the build, and a credential scan of the build output before any deployment.
4. IF any pre-deployment check fails, THEN THE NGF_Site SHALL NOT deploy and the previously deployed site SHALL continue to serve.
5. THE NGF_Site SHALL set every secret outside the repository and SHALL NOT include any secret value in configuration files, source files, or build logs.
6. THE NGF_Site SHALL NOT contain any pattern matching a repository token, an AI provider key, a session secret, or a private key header in its build output.
7. THE NGF_Site SHALL provide an environment variable example file listing every required variable name with placeholder values only.
8. THE NGF_Site SHALL provide project documentation covering setup, local development, environment variables, content structure, the admin workflow, the product lifecycle, deployment, and the operator checklist of outstanding content.
9. THE NGF_Site SHALL make the production site URL configurable so that attaching a purchased domain requires only a configuration change.
10. THE NGF_Site SHALL NOT include committed changes directly to the default branch as part of the implementation workflow; implementation changes SHALL be delivered through a pull request.
