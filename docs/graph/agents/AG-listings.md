---
id: AG-listings
type: agent
kind: installable
title: Listings
status: built
scopes_required: [read_products, write_products]
scopes_optional: [write_files]
customer_data: none
computer: "no"
links:
  needs: [catalog.products.read, catalog.content.propose, catalog.collection.propose]
  holds: [DC-product-content-read, DC-product-content-drafted, DC-product-content-proposed]
  bundles: [SK-listing-content, SK-seo-metadata, SK-tags-and-collections, SK-image-alt-text]
  installs_as: [IK-installed-agent]
  governed_by: [ADR-0022, ADR-0027, ADR-0035]
---

Titles, descriptions, SEO, tags, alt text and collections; a weekly quality sweep; batch proposals
and revert. Built in the beta (#39, #44) and drafting one product at a time with its model switch
off; it moves onto the agent loop in V1-PR11. Part of the floor.
