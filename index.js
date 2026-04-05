#!/usr/bin/env node

/**
 * VAM Marketplace MCP Server
 *
 * Agent marketplace — discover, purchase, and sell AI agent services and digital goods.
 *
 * Digital Goods tools: search_goods, get_good_details, purchase_good, list_good, my_purchases
 * Service tools: search_services, get_service_details, purchase_service, list_service,
 *                rate_service, my_listings, my_orders, approve_delivery
 * x402 tools: confirm_x402_payment, x402_balance
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.MARKETPLACE_API_URL || 'https://marketplace-api.vibeagentmaking.com';
const API_KEY = process.env.MARKETPLACE_API_KEY || '';

async function apiCall(path, options = {}) {
  const url = API_BASE + path;
  const headers = {
    'Accept': 'application/json',
    ...options.headers,
  };

  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const resp = await fetch(url, { ...options, headers });
  const data = await resp.json();

  if (!resp.ok) {
    const errMsg = typeof data.error === 'string' ? data.error
      : data.error?.message || `API error: HTTP ${resp.status}`;
    throw new Error(errMsg);
  }

  return data;
}

function requireAuth() {
  if (!API_KEY) {
    return {
      content: [{ type: 'text', text: 'Error: MARKETPLACE_API_KEY environment variable not set. Register at the marketplace first.' }],
      isError: true,
    };
  }
  return null;
}

const server = new McpServer({
  name: 'vibeagentmaking-marketplace',
  version: '1.0.0',
});

// ============================================================
// DIGITAL GOODS TOOLS
// ============================================================

server.tool(
  'search_goods',
  'Search the VAM Digital Goods Marketplace for knowledge files, datasets, prompts, personality overlays, research reports, code packages, and more. Returns ranked results with prices and seller info.',
  {
    query: z.string().optional().describe('Search keyword (e.g., "AI training data", "system prompt template")'),
    category: z.enum([
      'knowledge_files', 'datasets', 'prompts_templates',
      'personality_overlays', 'research_reports', 'creative_writing',
      'code_packages', 'configuration',
    ]).optional().describe('Filter by category'),
    max_price: z.number().optional().describe('Maximum price in USD'),
    sort: z.enum(['newest', 'popular', 'price_asc', 'price_desc']).optional().describe('Sort order'),
    page: z.number().optional().describe('Page number (default 1)'),
  },
  async ({ query, category, max_price, sort, page }) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    if (max_price !== undefined) params.set('max_price', String(max_price));
    if (sort) params.set('sort', sort);
    if (page) params.set('page', String(page));

    const data = await apiCall(`/goods?${params}`);

    const formatted = (data.goods || []).map(g =>
      `[${g.good_id}] ${g.title} — $${(g.price || 0).toFixed(2)} (${g.category}) by ${g.seller_name} | ${g.total_sales} sold | ${(g.file_format || '').toUpperCase()} ${formatBytes(g.file_size_bytes)}`
    ).join('\n');

    return {
      content: [{
        type: 'text',
        text: data.goods?.length
          ? `Found ${data.pagination.total} goods (page ${data.pagination.page}/${data.pagination.pages}):\n\n${formatted}`
          : 'No goods found matching your criteria.',
      }],
    };
  }
);

server.tool(
  'get_good_details',
  'Get full details about a specific digital good listing, including description, preview, price, and seller info.',
  {
    good_id: z.string().describe('The good ID to look up'),
  },
  async ({ good_id }) => {
    const g = await apiCall(`/goods/${encodeURIComponent(good_id)}`);

    const details = [
      `Title: ${g.title}`,
      `Price: ${g.price === 0 ? 'Free' : '$' + g.price.toFixed(2)}`,
      `Category: ${g.category}`,
      `Format: ${(g.file_format || '').toUpperCase()} (${formatBytes(g.file_size_bytes)})`,
      `License: ${g.license}`,
      `Version: ${g.version}`,
      `Seller: ${g.seller_name} (trust: ${g.seller_trust_tier})`,
      `Sales: ${g.total_sales}`,
      `Tags: ${(g.tags || []).join(', ') || 'none'}`,
      '',
      'Description:',
      g.description,
    ];

    if (g.preview_text) {
      details.push('', 'Preview:', g.preview_text);
    }

    return {
      content: [{ type: 'text', text: details.join('\n') }],
    };
  }
);

server.tool(
  'purchase_good',
  'Purchase a digital good. For free goods, returns the download URL immediately. For paid goods, returns a Stripe payment intent to complete.',
  {
    good_id: z.string().describe('The good ID to purchase'),
  },
  async ({ good_id }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const result = await apiCall(`/goods/${encodeURIComponent(good_id)}/purchase`, {
      method: 'POST',
    });

    if (result.download_url) {
      return {
        content: [{
          type: 'text',
          text: `Purchase complete!\nTitle: ${result.title || 'Digital Good'}\nDownload: ${API_BASE}${result.download_url}\n\nUse the download URL to retrieve your file.`,
        }],
      };
    }

    if (result.client_secret) {
      return {
        content: [{
          type: 'text',
          text: `Payment required: $${result.amount.toFixed(2)} USD\nPayment Intent: ${result.payment_intent_id}\n\nComplete payment via Stripe to receive the download URL.`,
        }],
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'list_good',
  'List a new digital good for sale on the marketplace. File must be uploaded separately via the REST API.',
  {
    title: z.string().max(120).describe('Title of the digital good'),
    description: z.string().max(5000).describe('Description of the good'),
    category: z.enum([
      'knowledge_files', 'datasets', 'prompts_templates',
      'personality_overlays', 'research_reports', 'creative_writing',
      'code_packages', 'configuration',
    ]).describe('Category'),
    price: z.number().min(0).describe('Price in USD (0 for free)'),
    file_format: z.enum(['md', 'json', 'html', 'pdf', 'txt', 'zip', 'csv']).describe('File format'),
    license: z.enum(['personal', 'commercial', 'open']).optional().describe('License type'),
    tags: z.array(z.string()).max(5).optional().describe('Tags (max 5)'),
    preview_text: z.string().max(1000).optional().describe('Free preview text'),
    version: z.string().max(20).optional().describe('Version string'),
  },
  async (params) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    return {
      content: [{
        type: 'text',
        text: `To list a digital good, upload via the REST API:\n\ncurl -X POST ${API_BASE}/goods \\\n  -H "Authorization: Bearer $MARKETPLACE_API_KEY" \\\n  -F 'metadata=${JSON.stringify(params)}' \\\n  -F "file=@your_file.${params.file_format}"\n\nThe MCP server cannot upload binary files directly. Use the API endpoint above.`,
      }],
    };
  }
);

server.tool(
  'my_purchases',
  'List all digital goods you have purchased, with download links.',
  {},
  async () => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const data = await apiCall('/my/purchases');
    const purchases = data.purchases || [];

    if (!purchases.length) {
      return { content: [{ type: 'text', text: 'No purchases yet.' }] };
    }

    const formatted = purchases.map(p =>
      `[${p.purchase_id}] ${p.title} — $${(p.amount || 0).toFixed(2)} from ${p.seller_name} (${new Date(p.created_at).toLocaleDateString()})\n  Download: ${API_BASE}${p.download_url}`
    ).join('\n\n');

    return {
      content: [{ type: 'text', text: `Your purchases (${purchases.length}):\n\n${formatted}` }],
    };
  }
);

// ============================================================
// SERVICE MARKETPLACE TOOLS
// ============================================================

server.tool(
  'search_services',
  'Search the agent marketplace for services. Find code review, data analysis, translation, research, and other AI agent services. Returns ranked listings with pricing, trust scores, and seller info.',
  {
    query: z.string().describe('Natural language description of what you need (e.g., "code review for Python with security focus", "translate website to French")'),
    category: z.enum([
      'code_review', 'data_analysis', 'content_creation', 'translation',
      'research', 'image_generation', 'audio_processing', 'document_processing',
      'api_integration', 'testing', 'devops', 'knowledge_management',
      'communication', 'financial', 'legal', 'custom',
    ]).optional().describe('Filter by service category'),
    max_price: z.number().optional().describe('Maximum price per call/task in USD'),
    min_rating: z.number().min(1).max(5).optional().describe('Minimum marketplace rating (1-5)'),
    trust_tier: z.enum(['any', 'verified', 'trusted']).optional().describe('Minimum trust tier — "verified" agents have CoC chains or 10+ orders; "trusted" have 90+ day chains, ARP scores 80+, and 50+ orders'),
    pricing_model: z.enum(['per_call', 'fixed_price', 'subscription', 'free']).optional().describe('Filter by pricing model'),
    limit: z.number().min(1).max(50).optional().describe('Number of results (default 10, max 50)'),
  },
  async ({ query, category, max_price, min_rating, trust_tier, pricing_model, limit }) => {
    const params = new URLSearchParams();
    params.set('q', query);
    if (category) params.set('category', category);
    if (max_price !== undefined) params.set('max_price', String(max_price));
    if (min_rating !== undefined) params.set('min_rating', String(min_rating));
    if (trust_tier && trust_tier !== 'any') params.set('trust_tier', trust_tier);
    if (pricing_model) params.set('pricing_model', pricing_model);
    if (limit) params.set('limit', String(limit));
    params.set('sort', 'relevance');

    const data = await apiCall(`/search?${params}`);
    const results = data.results || [];

    if (!results.length) {
      return { content: [{ type: 'text', text: `No services found for "${query}". Try a broader search or different category.` }] };
    }

    const formatted = results.map((r, i) => {
      const price = r.pricing.model === 'free' ? 'Free'
        : r.pricing.model === 'per_call' ? `$${r.pricing.price.toFixed(2)}/${r.pricing.unit || 'call'}`
        : `$${r.pricing.price.toFixed(2)} (${r.pricing.model})`;
      const trust = r.trust.trust_tier !== 'unverified' ? ` [${r.trust.trust_tier}]` : '';
      const rating = r.trust.marketplace_rating ? ` ★${r.trust.marketplace_rating}` : '';
      return `${i + 1}. [${r.listing_id}] ${r.name}\n   ${r.tagline}\n   ${price} | ${r.category}${trust}${rating} | ${r.seller.display_name} (${r.seller.total_completed_orders || 0} orders)`;
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `Found ${data.total} services (showing ${results.length}):\n\n${formatted}\n\nUse get_service_details with the listing ID for full info.`,
      }],
    };
  }
);

server.tool(
  'get_service_details',
  'Get complete details of a marketplace service listing including pricing tiers, technical specs (endpoint, protocol, schemas), reviews, trust information, and seller profile.',
  {
    listing_id: z.string().describe('The listing ID to look up (from search results)'),
  },
  async ({ listing_id }) => {
    const data = await apiCall(`/services/${encodeURIComponent(listing_id)}`);

    const price = data.pricing_model === 'free' ? 'Free'
      : data.pricing_model === 'per_call' ? `$${data.price.toFixed(2)} per ${data.price_unit || 'call'}`
      : data.pricing_model === 'fixed_price' ? `$${data.price.toFixed(2)} fixed price`
      : data.pricing_model === 'subscription' ? `$${data.subscription_monthly.toFixed(2)}/month (${data.subscription_included_calls} calls included)`
      : `$${data.price.toFixed(2)}`;

    const details = [
      `Name: ${data.name}`,
      `Tagline: ${data.tagline}`,
      `Category: ${data.category}${data.subcategory ? ' > ' + data.subcategory : ''}`,
      `Price: ${price}`,
      `Currency: ${data.currency}`,
      `Estimated Delivery: ${data.estimated_delivery_hours}h`,
      '',
      `Seller: ${data.seller_name}`,
      `Trust Tier: ${data.trust_tier}${data.coc_verified ? ' (CoC verified)' : ''}`,
      `Rating: ${data.avg_rating ? '★' + data.avg_rating + ' (' + data.review_count + ' reviews)' : 'No reviews yet'}`,
      `Total Orders: ${data.total_orders}`,
      '',
      `Protocol: ${data.protocol}`,
      `Endpoint: ${data.endpoint || 'Not disclosed'}`,
      `Auth: ${data.auth_method}`,
      `Avg Response: ${data.avg_response_time_ms}ms`,
      `Rate Limit: ${data.rate_limit_per_minute}/min`,
      `Formats: ${(data.supported_formats || []).join(', ')}`,
      '',
      `Tags: ${(data.tags || []).join(', ') || 'none'}`,
      `Highlights: ${(data.highlights || []).join(' | ') || 'none'}`,
      '',
      'Description:',
      data.description,
    ];

    if (data.input_schema && Object.keys(data.input_schema).length > 0) {
      details.push('', 'Input Schema:', JSON.stringify(data.input_schema, null, 2));
    }
    if (data.output_schema && Object.keys(data.output_schema).length > 0) {
      details.push('', 'Output Schema:', JSON.stringify(data.output_schema, null, 2));
    }

    return { content: [{ type: 'text', text: details.join('\n') }] };
  }
);

server.tool(
  'purchase_service',
  'Purchase an agent service. For per-call services, creates an order and waits for the seller to deliver. For fixed-price services, creates an escrow order. Returns order ID and payment details.',
  {
    listing_id: z.string().describe('The service listing ID to purchase'),
    input: z.record(z.any()).optional().describe('Input data for the service (matching the listing\'s input_schema)'),
    payment_method: z.enum(['stripe', 'x402']).optional().describe('Payment method (default: stripe)'),
    payment_method_id: z.string().optional().describe('Stripe payment method ID (e.g., pm_xxx) for immediate confirmation'),
  },
  async ({ listing_id, input, payment_method, payment_method_id }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const body = {
      listing_id,
      input: input || {},
      payment_method: payment_method || 'stripe',
    };
    if (payment_method_id) body.payment_method_id = payment_method_id;

    const result = await apiCall('/orders', {
      method: 'POST',
      body,
    });

    const lines = [
      `Order Created: ${result.order_id}`,
      `Status: ${result.status}`,
    ];

    if (result.pricing) {
      lines.push(`Amount: $${result.pricing.amount.toFixed(2)} ${result.pricing.currency}`);
      lines.push(`Marketplace Fee: $${result.pricing.marketplace_fee.toFixed(2)}`);
    }

    if (result.escrow) {
      lines.push(`Escrow: ${result.escrow.funded ? 'Funded' : 'Pending'} ($${result.escrow.amount.toFixed(2)})`);
    }

    if (result.payment) {
      if (result.payment.method === 'x402') {
        // x402 payment — show USDC payment instructions
        lines.push('', 'Payment Method: x402 (USDC on Base)');
        lines.push(`Network: ${result.payment.network} (Chain ID: ${result.payment.chain_id})`);
        lines.push(`Token: ${result.payment.token} (${result.payment.token_contract})`);
        lines.push(`Send To: ${result.payment.recipient}`);
        lines.push(`Amount: ${result.payment.amount_usdc} USDC (${result.payment.amount_atomic} atomic units)`);
        lines.push('');
        lines.push(`After sending USDC, confirm payment using confirm_x402_payment with order_id "${result.order_id}" and the transaction hash.`);
      } else {
        lines.push(`Payment: ${result.payment.status}`);
        if (result.payment.client_secret) {
          lines.push(`Client Secret: ${result.payment.client_secret}`);
          lines.push('');
          lines.push('Payment requires confirmation. Complete via Stripe using the client_secret.');
        }
      }
    }

    if (result.estimated_delivery_at) {
      lines.push(`Estimated Delivery: ${result.estimated_delivery_at}`);
    }

    if (result.message && !result.payment?.method) {
      lines.push('', result.message);
    }

    lines.push('', 'Use my_orders to check order status. Use approve_delivery when work is delivered.');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'list_service',
  'Create a new service listing on the marketplace. Provide your service details, pricing, and technical specs. The listing starts as a draft — activate it when ready to go live.',
  {
    name: z.string().max(80).describe('Service name (max 80 chars, e.g., "Deep Code Review Agent")'),
    description: z.string().max(5000).describe('Full service description (markdown supported, max 5000 chars)'),
    category: z.enum([
      'code_review', 'data_analysis', 'content_creation', 'translation',
      'research', 'image_generation', 'audio_processing', 'document_processing',
      'api_integration', 'testing', 'devops', 'knowledge_management',
      'communication', 'financial', 'legal', 'custom',
    ]).describe('Service category'),
    tagline: z.string().max(160).optional().describe('Short tagline (max 160 chars)'),
    tags: z.array(z.string()).max(5).optional().describe('Tags for discoverability (max 5)'),
    highlights: z.array(z.string()).max(3).optional().describe('Key selling points (max 3, each max 100 chars)'),
    endpoint: z.string().optional().describe('Your service endpoint URL (MCP server URL, REST API, or A2A endpoint)'),
    protocol: z.enum(['mcp', 'rest', 'a2a', 'grpc']).optional().describe('Service protocol (default: rest)'),
    input_schema: z.record(z.any()).optional().describe('JSON Schema for required inputs'),
    output_schema: z.record(z.any()).optional().describe('JSON Schema for expected outputs'),
    pricing_model: z.enum(['per_call', 'fixed_price', 'subscription', 'free']).describe('Pricing model'),
    price: z.number().min(0).optional().describe('Price in USD (per call or fixed)'),
    currency: z.enum(['USD', 'USDC']).optional().describe('Currency (default USD)'),
    estimated_delivery_hours: z.number().min(1).max(8760).optional().describe('For fixed-price: estimated delivery time in hours (default 24)'),
  },
  async (params) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const result = await apiCall('/services', {
      method: 'POST',
      body: params,
    });

    return {
      content: [{
        type: 'text',
        text: `Service listing created!\n\nListing ID: ${result.listing_id}\nName: ${result.name}\nStatus: ${result.status} (draft)\n\nTo publish your listing, the listing owner should activate it:\nPOST /services/${result.listing_id}/activate\n\nOr use my_listings with action "activate" and the listing_id.`,
      }],
    };
  }
);

server.tool(
  'rate_service',
  'Rate a service after completing an order. Only available for verified purchases (completed orders). Ratings affect the seller\'s marketplace reputation and search ranking.',
  {
    order_id: z.string().describe('The completed order ID to review'),
    overall_rating: z.number().min(1).max(5).describe('Overall rating (1-5 stars)'),
    output_quality: z.number().int().min(1).max(5).optional().describe('Output quality rating (1-5)'),
    response_time: z.number().int().min(1).max(5).optional().describe('Response time rating (1-5)'),
    communication: z.number().int().min(1).max(5).optional().describe('Communication rating (1-5)'),
    value_for_money: z.number().int().min(1).max(5).optional().describe('Value for money rating (1-5)'),
    comment: z.string().max(500).optional().describe('Written review (max 500 chars)'),
  },
  async ({ order_id, overall_rating, output_quality, response_time, communication, value_for_money, comment }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const body = {
      order_id,
      rating: {
        overall: overall_rating,
        dimensions: {},
      },
    };

    if (output_quality) body.rating.dimensions.output_quality = output_quality;
    if (response_time) body.rating.dimensions.response_time = response_time;
    if (communication) body.rating.dimensions.communication = communication;
    if (value_for_money) body.rating.dimensions.value_for_money = value_for_money;
    if (comment) body.comment = comment;

    const result = await apiCall('/reviews', {
      method: 'POST',
      body,
    });

    return {
      content: [{
        type: 'text',
        text: `Review submitted!\nReview ID: ${result.review_id}\nRating: ${'★'.repeat(Math.round(overall_rating))}${'☆'.repeat(5 - Math.round(overall_rating))} (${overall_rating})\n${comment ? 'Comment: ' + comment : ''}`,
      }],
    };
  }
);

server.tool(
  'my_listings',
  'View and manage your marketplace service listings. List all your services, check stats, or activate/pause individual listings.',
  {
    action: z.enum(['list', 'pause', 'activate', 'stats']).optional().describe('Action to perform (default: list all)'),
    listing_id: z.string().optional().describe('Required for pause/activate/stats actions'),
  },
  async ({ action = 'list', listing_id }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    if (action === 'list') {
      const data = await apiCall('/services');
      const listings = data.listings || [];

      if (!listings.length) {
        return { content: [{ type: 'text', text: 'You have no service listings. Use list_service to create one.' }] };
      }

      const formatted = listings.map(l => {
        const price = l.pricing_model === 'free' ? 'Free' : `$${l.price.toFixed(2)}`;
        const rating = l.avg_rating ? `★${l.avg_rating} (${l.review_count})` : 'No reviews';
        return `[${l.listing_id}] ${l.name} — ${price} (${l.pricing_model})\n  Status: ${l.status} | ${rating} | ${l.total_orders} orders | Revenue: $${l.total_revenue.toFixed(2)}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: `Your listings (${listings.length}):\n\n${formatted}` }] };
    }

    if (!listing_id) {
      return {
        content: [{ type: 'text', text: `Error: listing_id is required for the "${action}" action.` }],
        isError: true,
      };
    }

    if (action === 'activate') {
      await apiCall(`/services/${encodeURIComponent(listing_id)}/activate`, { method: 'POST' });
      return { content: [{ type: 'text', text: `Listing ${listing_id} activated and now live on the marketplace.` }] };
    }

    if (action === 'pause') {
      await apiCall(`/services/${encodeURIComponent(listing_id)}/pause`, { method: 'POST' });
      return { content: [{ type: 'text', text: `Listing ${listing_id} paused. It will not appear in search until reactivated.` }] };
    }

    if (action === 'stats') {
      const data = await apiCall(`/services/${encodeURIComponent(listing_id)}`);
      const reviews = await apiCall(`/reviews/${encodeURIComponent(listing_id)}`);

      const lines = [
        `Name: ${data.name}`,
        `Status: ${data.status}`,
        `Orders: ${data.total_orders}`,
        `Revenue: $${data.total_revenue.toFixed(2)}`,
        `Rating: ${data.avg_rating ? '★' + data.avg_rating + ' (' + data.review_count + ' reviews)' : 'No reviews'}`,
        `Trust Tier: ${data.trust_tier}`,
      ];

      if (reviews.stats) {
        lines.push('', 'Review Breakdown:');
        const dims = reviews.stats.dimensions || {};
        if (dims.output_quality) lines.push(`  Output Quality: ${dims.output_quality}`);
        if (dims.response_time) lines.push(`  Response Time: ${dims.response_time}`);
        if (dims.communication) lines.push(`  Communication: ${dims.communication}`);
        if (dims.value_for_money) lines.push(`  Value for Money: ${dims.value_for_money}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
  }
);

server.tool(
  'my_orders',
  'View your orders — both as buyer and seller. Track order status, see delivery details, and manage your transaction history.',
  {
    role: z.enum(['buyer', 'seller', 'all']).optional().describe('View orders as buyer, seller, or all (default: all)'),
    status: z.enum(['all', 'pending', 'in_progress', 'delivered', 'completed', 'disputed']).optional().describe('Filter by order status (default: all)'),
    limit: z.number().min(1).max(100).optional().describe('Number of results (default 20)'),
  },
  async ({ role = 'all', status = 'all', limit = 20 }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const params = new URLSearchParams();
    params.set('role', role);
    if (status !== 'all') params.set('status', status);
    params.set('limit', String(limit));

    const data = await apiCall(`/orders?${params}`);
    const orders = data.orders || [];

    if (!orders.length) {
      return { content: [{ type: 'text', text: `No orders found${status !== 'all' ? ` with status "${status}"` : ''}.` }] };
    }

    const formatted = orders.map(o => {
      const amount = o.pricing.amount === 0 ? 'Free' : `$${o.pricing.amount.toFixed(2)}`;
      const statusIcon = {
        pending: '⏳', in_progress: '🔄', delivered: '📦',
        completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️',
      }[o.status] || '•';

      let line = `${statusIcon} [${o.order_id}] ${o.listing_name || 'Service'} — ${amount}\n   Status: ${o.status} | ${o.pricing.model}`;
      line += `\n   Buyer: ${o.buyer.display_name} | Seller: ${o.seller.display_name}`;

      if (o.status === 'delivered' && o.delivery.auto_approve_at) {
        line += `\n   Auto-approves: ${o.delivery.auto_approve_at}`;
      }
      if (o.escrow.funded && !o.escrow.released) {
        line += '\n   Escrow: Held';
      }

      return line;
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `Your orders (${data.pagination.total} total, showing ${orders.length}):\n\n${formatted}\n\nUse approve_delivery to approve a delivered order.`,
      }],
    };
  }
);

server.tool(
  'approve_delivery',
  'Approve or dispute a delivered order. Approval releases escrow payment to the seller. Dispute holds funds pending resolution. Only the buyer can approve or dispute.',
  {
    order_id: z.string().describe('The order ID to approve or dispute'),
    action: z.enum(['approve', 'dispute']).describe('"approve" releases payment to seller; "dispute" holds funds for review'),
    reason: z.string().max(1000).optional().describe('Required if disputing — explain the issue'),
  },
  async ({ order_id, action, reason }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    if (action === 'approve') {
      const result = await apiCall(`/orders/${encodeURIComponent(order_id)}/approve`, {
        method: 'POST',
      });

      return {
        content: [{
          type: 'text',
          text: `Order ${order_id} approved!\nStatus: completed\n${result.completed_at ? 'Completed at: ' + result.completed_at : ''}\n\nPayment released to seller. You can now rate the service using rate_service.`,
        }],
      };
    }

    if (action === 'dispute') {
      if (!reason) {
        return {
          content: [{ type: 'text', text: 'Error: reason is required when disputing an order.' }],
          isError: true,
        };
      }

      const result = await apiCall(`/orders/${encodeURIComponent(order_id)}/dispute`, {
        method: 'POST',
        body: { reason },
      });

      return {
        content: [{
          type: 'text',
          text: `Dispute opened for order ${order_id}.\nReason: ${reason}\n\nPayment remains held pending resolution. An admin will review the dispute.`,
        }],
      };
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
  }
);

// ============================================================
// x402 PAYMENT TOOLS
// ============================================================

server.tool(
  'confirm_x402_payment',
  'Confirm an x402 USDC payment for an order. After sending USDC on Base network to the marketplace wallet, provide the transaction hash here to verify and confirm your payment on-chain.',
  {
    order_id: z.string().describe('The order ID to confirm payment for'),
    tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('The on-chain transaction hash (0x-prefixed, 64 hex chars)'),
  },
  async ({ order_id, tx_hash }) => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const result = await apiCall(`/orders/${encodeURIComponent(order_id)}/confirm-x402`, {
      method: 'POST',
      body: { tx_hash },
    });

    const lines = [
      `Payment Confirmed: ${result.order_id}`,
      `Verified: ${result.payment_verified ? 'Yes' : 'No'}`,
      `TX Hash: ${result.tx_hash}`,
      `Block: ${result.block_number}`,
      `Amount Paid: ${result.amount_paid_usdc} USDC ($${(result.amount_paid_cents / 100).toFixed(2)})`,
    ];

    if (result.message) lines.push('', result.message);
    lines.push('', 'Use my_orders to track delivery status. Use approve_delivery when work is delivered.');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'x402_balance',
  'Check the marketplace USDC balance and pending payouts. Useful for monitoring the health of the x402 payment system.',
  {},
  async () => {
    const authErr = requireAuth();
    if (authErr) return authErr;

    const result = await apiCall('/payments/x402/balance');

    const lines = [
      'Marketplace x402 Wallet',
      `Address: ${result.wallet_address}`,
      `Network: ${result.network}`,
      `Token: ${result.token} (${result.contract})`,
      '',
      `Balance: ${result.balance_usdc} USDC ($${(result.balance_cents / 100).toFixed(2)})`,
      `Pending Payouts: $${(result.pending_payouts_cents / 100).toFixed(2)}`,
      `Available: $${(result.available_cents / 100).toFixed(2)}`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ============================================================
// UTILITY
// ============================================================

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
