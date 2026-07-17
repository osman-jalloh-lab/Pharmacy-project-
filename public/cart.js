import { readCart, updateQuantity, removeFromCart, clearCart, updateBadges, formatMoney } from "/cart-store.js";
const $=selector=>document.querySelector(selector),esc=value=>String(value??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])),fmtInt=n=>Number(n).toLocaleString("en");
const INQUIRY_REASONS=[["wholesale_price","Request wholesale price"],["availability","Confirm availability"],["larger_quantity","Request a larger quantity"],["shipping","Ask about shipping"],["documentation","Ask about product documentation"],["minimum_order","Ask about minimum order quantity"],["different_brand","Request a different brand"],["alternative_product","Request a similar product"],["other","Other"]];
let verified=null,verifyTimer=null,panelMode=null,panelScope=null,panelJustOpened=false;

async function post(url,payload){const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const body=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(body?.issues?.[0]?.message||body.message||"The request failed."),{body});return body;}

function lineMeta(line){return [line.genericName!==line.displayName?line.genericName:null,line.brandName,line.strength,line.dosageForm,line.manufacturer].filter(Boolean).map(esc).join(" · ");}
function packLine(line){if(line.boxesPerCarton==null)return '<span class="unavailable">Carton configuration requires supplier confirmation.</span>';const parts=[`${fmtInt(line.boxesPerCarton)} boxes per carton`];if(line.unitsPerBox!=null)parts.push(`${fmtInt(line.unitsPerBox)} ${esc(line.unitKind||"units")} per box`);return parts.join(" · ");}
function lineTotals(line){if(line.status!=="ok")return "";const parts=[`<b>${fmtInt(line.cartonQuantity)} carton${line.cartonQuantity===1?"":"s"}</b>`];if(line.totalBoxes!=null)parts.push(`${fmtInt(line.totalBoxes)} boxes`);if(line.totalUnits!=null)parts.push(`${fmtInt(line.totalUnits)} ${esc(line.unitKind||"units")}`);const money=line.lineSubtotalCents!=null?`Item subtotal: <b>${esc(formatMoney(line.lineSubtotalCents,line.currency))}</b>`:"Item price: <b>quotation required</b>";return `<p class="line-totals">${parts.join(" · ")}</p><p class="line-money">${line.pricePerCartonCents!=null?`${esc(formatMoney(line.pricePerCartonCents,line.currency))} per carton · `:""}${money}</p>`;}

function renderLine(line){const w=line.wholesale||{};const stepper=line.code!=="missing_product"?`<div class="qty-stepper compact"><button type="button" class="qty-btn" data-step="-1" data-product="${line.productId}" aria-label="Decrease cartons of ${esc(line.displayName)}">−</button><label class="sr-only" for="qty-${line.productId}">Carton quantity for ${esc(line.displayName)}</label><input id="qty-${line.productId}" type="number" inputmode="numeric" min="1" step="1" value="${line.cartonQuantity}" data-qty="${line.productId}"><button type="button" class="qty-btn" data-step="1" data-product="${line.productId}" aria-label="Increase cartons of ${esc(line.displayName)}">+</button></div>`:"";
return `<article class="cart-line ${line.status==="ok"?"":"has-error"}" aria-label="${esc(line.displayName)}">
${line.imageUrl?`<img src="${esc(line.imageUrl)}" alt="" width="86" height="86">`:'<span class="line-noimg" aria-hidden="true">℞</span>'}
<div class="line-body"><h3>${line.slug?`<a href="/product.html?slug=${encodeURIComponent(line.slug)}">${esc(line.displayName)}</a>`:esc(line.displayName||`Product #${line.productId}`)}</h3>
<p class="line-meta">${lineMeta(line)}</p>
<p class="line-pack">${packLine(line)}</p>
${w.statusLabel?`<span class="ws-status ws-${esc(w.status)}">${esc(w.statusLabel)}</span>`:""}
${line.status==="ok"?lineTotals(line):`<p class="line-error">${esc(line.message)}</p>`}
</div>
<div class="line-side">${stepper}<div class="line-actions"><button class="btn btn-outline btn-small" data-inquire-item="${line.productId}" type="button">Submit inquiry</button><button class="remove" data-remove="${line.productId}" type="button">Remove</button></div></div></article>`;}

function renderSummary(){const s=verified.summary,anyError=verified.lines.some(line=>line.status!=="ok");
const subtotal=s.subtotalCents!=null?esc(formatMoney(s.subtotalCents,s.currency)):(s.quoteRequired?"Requires quotation":"—");
return `<h2>Order summary</h2><dl class="summary-list">
<div><dt>Medication products</dt><dd>${fmtInt(s.productCount)}</dd></div>
<div><dt>Total cartons</dt><dd>${fmtInt(s.totalCartons)}</dd></div>
${s.totalBoxes!=null?`<div><dt>Total boxes</dt><dd>${fmtInt(s.totalBoxes)}</dd></div>`:""}
${s.totalUnits!=null?`<div><dt>Total units</dt><dd>${fmtInt(s.totalUnits)}</dd></div>`:""}
<div><dt>Merchandise subtotal</dt><dd>${subtotal}</dd></div>
<div><dt>Shipping</dt><dd>Confirmed by the pharmacy after review</dd></div>
<div><dt>Estimated total</dt><dd>${s.subtotalCents!=null?`${esc(formatMoney(s.subtotalCents,s.currency))} before shipping and taxes`:"Provided with your quotation"}</dd></div>
</dl>
${anyError?'<p class="summary-note error-note">Fix the highlighted items before checkout. You can still request a quotation for the full cart.</p>':""}
${s.checkoutEligible?'<button class="btn btn-primary btn-block" id="startCheckout" type="button">Continue to checkout</button>':'<p class="summary-note">Direct checkout is unavailable for this cart because at least one item needs a quotation or verification. Request a quotation instead.</p>'}
<button class="btn btn-dark btn-block" id="startCartInquiry" type="button">Request quotation for entire cart</button>
<a class="btn btn-soft btn-block" href="/">Continue shopping</a>`;}

function contactFields(prefix){return `<div class="field"><label for="${prefix}Name">Contact name</label><input id="${prefix}Name" required minlength="2" autocomplete="name"></div>
<div class="field"><label for="${prefix}Business">Business or pharmacy name (optional)</label><input id="${prefix}Business" autocomplete="organization"></div>
<div class="field"><label for="${prefix}Email">Email</label><input id="${prefix}Email" type="email" autocomplete="email" aria-describedby="${prefix}ContactHint"></div>
<div class="field"><label for="${prefix}Phone">Phone</label><input id="${prefix}Phone" type="tel" autocomplete="tel"><small id="${prefix}ContactHint">Provide an email address or phone number.</small></div>
<div class="field"><label for="${prefix}Country">Destination country</label><input id="${prefix}Country" autocomplete="country-name"></div>
<div class="field"><label for="${prefix}City">Destination city</label><input id="${prefix}City" autocomplete="address-level2"></div>`;}

function renderPanel(){const panel=$("#actionPanel");if(!panelMode){panel.innerHTML="";return;}
if(panelMode==="inquiry"&&panelScope&&!verified.lines.some(line=>line.productId===panelScope))panelScope=null;
if(panelMode==="checkout"&&!verified.summary.checkoutEligible){panelMode=null;panel.innerHTML="";return;}
const scopeLines=panelMode==="inquiry"&&panelScope?verified.lines.filter(line=>line.productId===panelScope):verified.lines;
const itemsSummary=`<ol class="inquiry-items">${scopeLines.map(line=>`<li>${esc(line.displayName)} — ${fmtInt(line.cartonQuantity)} carton${line.cartonQuantity===1?"":"s"}</li>`).join("")}</ol>`;
if(panelMode==="inquiry"){panel.innerHTML=`<section class="panel-card" aria-labelledby="panelTitle"><h2 id="panelTitle">${panelScope?"Product inquiry":"Full-cart quotation request"}</h2><p>The products and carton quantities below are attached automatically.</p>${itemsSummary}<form id="inquiryForm" novalidate>${contactFields("inq")}<div class="field"><label for="inqReason">Reason for inquiry</label><select id="inqReason">${INQUIRY_REASONS.map(([value,label])=>`<option value="${value}" ${value==="wholesale_price"?"selected":""}>${label}</option>`).join("")}</select></div><div class="field"><label for="inqTimeline">Requested delivery timeline (optional)</label><input id="inqTimeline" placeholder="Example: needed in Freetown within 6 weeks"></div><div class="field"><label for="inqMessage">Message (optional)</label><textarea id="inqMessage" maxlength="1400"></textarea></div><div class="form-status" id="panelStatus" role="status"></div><div class="ws-actions"><button class="btn btn-dark" type="submit">Submit inquiry</button><button class="btn btn-outline" type="button" id="panelCancel">Cancel</button></div><p class="ws-legal">Your inquiry is stored for pharmacy review. It is not a confirmed order, and no response time is guaranteed.</p></form></section>`;$("#inquiryForm").onsubmit=event=>submitInquiry(event,scopeLines);}
else{panel.innerHTML=`<section class="panel-card" aria-labelledby="panelTitle"><h2 id="panelTitle">Checkout — order request</h2><p>Review the final summary, then submit your order request. <b>No payment is taken online.</b> The pharmacy verifies stock, documentation, and delivery before any payment is arranged.</p>${itemsSummary}<p><b>Estimated total: ${esc(formatMoney(verified.summary.subtotalCents,verified.summary.currency))}</b> before shipping and taxes.</p><form id="checkoutForm" novalidate>${contactFields("ord")}<div class="field wide"><label for="ordAddress">Delivery address</label><textarea id="ordAddress" maxlength="400"></textarea></div><div class="field"><label for="ordShipping">Shipping preference (optional)</label><input id="ordShipping" placeholder="Example: air freight, sea freight, pickup"></div><div class="field"><label for="ordLicense">Wholesale or pharmacy license information (if applicable)</label><input id="ordLicense" maxlength="300"></div><div class="field wide"><label for="ordNotes">Order notes (optional)</label><textarea id="ordNotes" maxlength="1500"></textarea></div><div class="form-status" id="panelStatus" role="status"></div><div class="ws-actions"><button class="btn btn-primary" type="submit">Submit order request</button><button class="btn btn-outline" type="button" id="panelCancel">Cancel</button></div><p class="ws-legal">Submitting creates an order request with status “pending verification”. Licensing, prescription, or supplier verification may still be required before approval.</p></form></section>`;$("#checkoutForm").onsubmit=submitOrder;}
$("#panelCancel").onclick=()=>{panelMode=null;panelScope=null;renderPanel();};
if(panelJustOpened){panelJustOpened=false;$("#actionPanel").scrollIntoView({behavior:"smooth",block:"start"});panel.querySelector("input,select,textarea")?.focus();}}

function render(){const root=$("#cartRoot");updateBadges();const stored=readCart();
if(!stored.length){root.innerHTML='<div class="empty"><h1>Your wholesale cart is empty</h1><p>Search the catalogue, open a medicine, choose a carton quantity, and add it here.</p><a class="btn btn-dark" href="/">Browse medicines</a></div>';return;}
if(!verified){root.innerHTML='<p class="loading">Checking prices, packaging, and stock…</p>';return;}
const activeId=document.activeElement?.id;
root.innerHTML=`<h1>Wholesale cart</h1><div class="cart-layout"><section aria-label="Cart items" id="cartLines">${verified.lines.map(renderLine).join("")}</section><aside class="cart-aside" id="cartSummary">${renderSummary()}</aside></div><div id="actionPanel"></div>`;
if(activeId?.startsWith("qty-"))document.getElementById(activeId)?.focus();
$("#cartLines").addEventListener("click",onLineClick);$("#cartLines").addEventListener("input",onQtyInput);
if($("#startCheckout"))$("#startCheckout").onclick=()=>{panelMode="checkout";panelScope=null;panelJustOpened=true;renderPanel();};
$("#startCartInquiry").onclick=()=>{panelMode="inquiry";panelScope=null;panelJustOpened=true;renderPanel();};
renderPanel();}

function onLineClick(event){const stepButton=event.target.closest("[data-step]");if(stepButton){const productId=Number(stepButton.dataset.product),input=$(`[data-qty="${productId}"]`),next=Math.max(1,(Number(input.value)||1)+Number(stepButton.dataset.step));input.value=next;queueUpdate(productId,next);return;}
const removeButton=event.target.closest("[data-remove]");if(removeButton){removeFromCart(Number(removeButton.dataset.remove));verified=null;render();verify();return;}
const inquireButton=event.target.closest("[data-inquire-item]");if(inquireButton){panelMode="inquiry";panelScope=Number(inquireButton.dataset.inquireItem);panelJustOpened=true;renderPanel();}}
function onQtyInput(event){const input=event.target.closest("[data-qty]");if(!input)return;const value=Number(input.value);if(Number.isInteger(value)&&value>0)queueUpdate(Number(input.dataset.qty),value);}
function queueUpdate(productId,cartonQuantity){updateQuantity(productId,cartonQuantity);clearTimeout(verifyTimer);verifyTimer=setTimeout(verify,350);}

async function verify(){const stored=readCart();if(!stored.length){verified=null;render();return;}
try{verified=await post("/api/cart/verify",{items:stored.map(item=>({productId:item.productId,cartonQuantity:item.cartonQuantity}))});}
catch(error){$("#cartRoot").innerHTML=`<div class="empty"><h1>The cart could not be checked</h1><p>${esc(error.message)}</p><button class="btn btn-dark" id="retryVerify" type="button">Try again</button></div>`;$("#retryVerify").onclick=()=>{verified=null;render();verify();};return;}
render();}

function collectContact(prefix,status){const name=$(`#${prefix}Name`).value.trim(),email=$(`#${prefix}Email`).value.trim(),phone=$(`#${prefix}Phone`).value.trim();
if(name.length<2){status.classList.add("error");status.textContent="Enter your contact name.";return null;}
if(!email&&!phone){status.classList.add("error");status.textContent="Provide an email address or phone number.";return null;}
return {customerName:name,businessName:$(`#${prefix}Business`).value,email,phone,destinationCountry:$(`#${prefix}Country`).value,destinationCity:$(`#${prefix}City`).value};}

async function submitInquiry(event,scopeLines){event.preventDefault();const status=$("#panelStatus");status.className="form-status";status.textContent="";
const contact=collectContact("inq",status);if(!contact)return;
const timeline=$("#inqTimeline").value.trim();let message=$("#inqMessage").value.trim();if(timeline)message=`${message?message+"\n":""}Requested delivery timeline: ${timeline}`;
const payload={...contact,message,inquiryReason:$("#inqReason").value,inquiryType:scopeLines.length===verified.lines.length?"cart":"single_product",items:scopeLines.map(line=>({productId:line.productId,cartonQuantity:line.cartonQuantity,quantityRequested:1,notes:""}))};
try{const body=await post("/api/inquiries",payload);showConfirmation({kind:"inquiry",reference:body.referenceNumber||body.id,lines:scopeLines,contact,extra:"The pharmacy will review your request and reply with availability, pricing, and shipping details. Nothing is confirmed until the pharmacy responds."});}
catch(error){status.classList.add("error");status.textContent=error.message;}}

async function submitOrder(event){event.preventDefault();const status=$("#panelStatus");status.className="form-status";status.textContent="";
const contact=collectContact("ord",status);if(!contact)return;
const payload={...contact,deliveryAddress:$("#ordAddress").value,shippingPreference:$("#ordShipping").value,wholesaleLicenseInfo:$("#ordLicense").value,orderNotes:$("#ordNotes").value,items:readCart().map(item=>({productId:item.productId,cartonQuantity:item.cartonQuantity}))};
try{const body=await post("/api/orders",payload);const lines=verified.lines;clearCart();showConfirmation({kind:"order",reference:body.referenceNumber,lines,contact,total:formatMoney(body.subtotalCents,body.currency),extra:"Status: pending verification. No payment has been taken. The pharmacy will verify stock, documentation, and delivery arrangements and then contact you about payment and shipping."});}
catch(error){status.classList.add("error");const problems=error.body?.problems;status.innerHTML=problems?.length?`${esc(error.message)}<br>${problems.map(problem=>esc(problem.message)).join("<br>")}`:esc(error.message);}}

function showConfirmation({kind,reference,lines,contact,total,extra}){$("#cartRoot").innerHTML=`<div class="confirm-card"><h1>${kind==="order"?"Order request submitted":"Inquiry submitted"}</h1>
<p class="form-status success">${kind==="order"?"Your order request was stored successfully.":"Your inquiry has been submitted successfully."}</p>
<dl class="summary-list"><div><dt>Reference number</dt><dd><b>${esc(reference)}</b></dd></div><div><dt>Status</dt><dd>${kind==="order"?"Pending verification":"Submitted, awaiting pharmacy review"}</dd></div>${total?`<div><dt>Estimated total</dt><dd>${esc(total)} before shipping and taxes</dd></div>`:""}<div><dt>Contact</dt><dd>${esc(contact.customerName)}${contact.email?` · ${esc(contact.email)}`:""}${contact.phone?` · ${esc(contact.phone)}`:""}</dd></div></dl>
<h2>Submitted products</h2><ol class="inquiry-items">${lines.map(line=>`<li>${esc(line.displayName)} — ${fmtInt(line.cartonQuantity)} carton${line.cartonQuantity===1?"":"s"}${line.totalBoxes!=null?` (${fmtInt(line.totalBoxes)} boxes)`:""}</li>`).join("")}</ol>
<h2>What happens next</h2><p>${esc(extra)} Keep the reference number for follow-up.</p>
<div class="ws-actions"><a class="btn btn-dark" href="/">Return to catalogue</a>${kind==="inquiry"?'<a class="btn btn-soft" href="/cart.html">Back to cart</a>':""}</div></div>`;updateBadges();window.scrollTo({top:0});}

const navToggle=$("#navToggle"),navPanel=$("#navLinks");function setMenu(open){navPanel.classList.toggle("open",open);navToggle.setAttribute("aria-expanded",String(open));}navToggle.onclick=()=>setMenu(!navPanel.classList.contains("open"));navPanel.addEventListener("click",event=>{if(event.target.closest("a"))setMenu(false);});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&navPanel.classList.contains("open")){setMenu(false);navToggle.focus();}});
render();verify();
