import { z } from "zod";
import { MAX_CARTONS } from "./wholesale.js";

export const INQUIRY_REASONS = ["wholesale_price", "availability", "larger_quantity", "shipping", "documentation", "minimum_order", "different_brand", "restock_notification", "alternative_product", "other"];
export const INQUIRY_TYPES = ["availability", "single_product", "cart", "checkout_fallback"];
export const INQUIRY_STATUSES = ["new", "under_review", "awaiting_customer", "quoted", "approved", "declined", "closed"];
export const ORDER_STATUSES = ["pending_verification", "quote_requested", "awaiting_payment", "payment_confirmed", "processing", "shipped", "delivered", "cancelled"];

const optionalText = max => z.union([z.string().trim().max(max), z.literal(""), z.null()]).optional();
const cartonQuantity = z.number().int().min(1).max(MAX_CARTONS);

const contactFields = {
  customerName: z.string().trim().min(2).max(100),
  email: z.union([z.string().trim().email().max(160), z.literal(""), z.null()]).optional(),
  phone: z.union([z.string().trim().regex(/^[0-9+() .-]{7,30}$/), z.literal(""), z.null()]).optional(),
  businessName: optionalText(160),
  destinationCountry: optionalText(80),
  destinationCity: optionalText(80)
};

function requireEmailOrPhone(value, context) {
  if (!value.email && !value.phone) context.addIssue({ code: "custom", path: ["email"], message: "Provide an email address or phone number." });
}

export const inquirySchema = z.object({
  ...contactFields,
  message: z.string().trim().max(1500).optional().default(""),
  inquiryReason: z.enum(INQUIRY_REASONS).optional().default("availability"),
  inquiryType: z.enum(INQUIRY_TYPES).optional().default("availability"),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    quantityRequested: z.number().int().min(1).max(99).default(1),
    cartonQuantity: cartonQuantity.nullable().optional(),
    notes: z.string().trim().max(300).optional().default("")
  })).min(1).max(20)
}).superRefine(requireEmailOrPhone);

export const cartVerifySchema = z.object({
  items: z.array(z.object({ productId: z.number().int().positive(), cartonQuantity })).min(1).max(40)
});

export const orderSchema = z.object({
  ...contactFields,
  deliveryAddress: optionalText(400),
  shippingPreference: optionalText(160),
  wholesaleLicenseInfo: optionalText(300),
  orderNotes: optionalText(1500),
  items: z.array(z.object({ productId: z.number().int().positive(), cartonQuantity })).min(1).max(40)
}).superRefine(requireEmailOrPhone);

export const productPatchSchema = z.object({
  displayName: z.string().trim().min(2).max(160).optional(), genericName: z.string().trim().max(160).nullable().optional(),
  brandName: z.string().trim().max(160).nullable().optional(), activeIngredient: z.string().trim().max(240).nullable().optional(),
  category: z.string().trim().min(2).max(100).optional(), dosageForm: z.string().trim().max(100).nullable().optional(),
  strength: z.string().trim().max(100).nullable().optional(), manufacturer: z.string().trim().max(160).nullable().optional(),
  packageSize: z.string().trim().max(100).nullable().optional(), description: z.string().trim().max(2000).nullable().optional(),
  commonUses: z.string().trim().max(3000).nullable().optional(), prescriptionStatus: z.enum(["prescription", "pharmacist_supervision", "non_prescription", "unknown"]).nullable().optional(),
  availabilityStatus: z.enum(["confirm_availability", "available", "unavailable"]).optional(), reviewStatus: z.enum(["needs_review", "needs_medical_review", "reviewed"]).optional(),
  unitsPerBox: z.number().int().min(1).max(100000).nullable().optional(), unitKind: z.string().trim().max(60).nullable().optional(),
  boxesPerCarton: z.number().int().min(1).max(100000).nullable().optional(), unitsPerCarton: z.number().int().min(1).max(10000000).nullable().optional(),
  minimumCartons: z.number().int().min(1).max(MAX_CARTONS).nullable().optional(), availableCartons: z.number().int().min(0).max(1000000).nullable().optional(),
  pricePerCartonCents: z.number().int().min(0).max(1000000000).nullable().optional(), currency: z.string().trim().regex(/^[A-Z]{3}$/).nullable().optional(),
  pricingMode: z.enum(["fixed", "quote_required", "contact_supplier"]).optional(),
  wholesaleStatus: z.enum(["in_stock", "low_stock", "out_of_stock", "available_by_request", "preorder", "quote_required", "temporarily_unavailable", "discontinued"]).optional(),
  wholesaleEnabled: z.boolean().optional(), directCheckoutEnabled: z.boolean().optional(),
  packagingReviewStatus: z.enum(["needs_review", "confirmed"]).optional()
});

export const imagePatchSchema = z.object({
  angleLabel: z.string().trim().max(80).nullable().optional(), sequenceIndex: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(), isPrimary: z.boolean().optional(), isVerified: z.boolean().optional(),
  licenseStatus: z.enum(["needs_review", "approved", "restricted", "rejected"]).optional(), reviewStatus: z.enum(["pending", "reviewed_folder_match", "reviewed", "rejected"]).optional(),
  ocrText: z.string().max(5000).nullable().optional(), ocrConfidence: z.number().min(0).max(1).nullable().optional()
});
