// Business rules for sales, debts and stock. Kept free of database and
// framework imports so the rules can be checked on their own.

import { shop_day_key } from "./dates";

export const LOW_STOCK_THRESHOLD = 5;

export const PAYMENT_METHODS = ["ZAAD", "E_DAHAB", "CASH"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

/** An error whose message is safe and useful to show the cashier. */
export class RuleError extends Error {}

export function round_money(amount: number) {
  return Math.round(amount * 100) / 100;
}

export function is_low_stock_qty(stock_qty: number) {
  return stock_qty <= LOW_STOCK_THRESHOLD;
}

export function is_payment_method(value: unknown): value is PaymentMethodValue {
  return (
    typeof value === "string" &&
    (PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

export type CartLine = {
  product_id: string;
  quantity: number;
  unit_price: number;
};

/**
 * Reads the cart the terminal sends. Only the product id, quantity and the
 * price the cashier settled on are taken from it; names and costs come from
 * the database.
 */
export function parse_cart(raw: string | null): CartLine[] {
  if (!raw) throw new RuleError("Cart is empty.");

  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    throw new RuleError("Invalid cart payload.");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new RuleError("Cart is empty.");
  }

  const seen = new Set<string>();

  return items.map((item) => {
    const product_id = item?.product?.id;
    const quantity = item?.quantity;
    const unit_price = item?.product?.price;

    if (typeof product_id !== "string" || product_id === "") {
      throw new RuleError("Invalid cart payload.");
    }
    if (seen.has(product_id)) {
      throw new RuleError(
        "The same product is in the cart twice. Refresh and try again.",
      );
    }
    seen.add(product_id);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RuleError("Quantities must be whole numbers above zero.");
    }
    if (typeof unit_price !== "number" || !Number.isFinite(unit_price)) {
      throw new RuleError("Every item needs a valid price.");
    }

    return { product_id, quantity, unit_price: round_money(unit_price) };
  });
}

export type Settlement = {
  amount_paid: number;
  remaining: number;
  status: "paid" | "partial" | "unpaid";
  repayment_date: Date;
};

/**
 * Works out how much of the sale is paid now and how much becomes debt.
 * A debt needs a customer to collect it from and a repayment date that
 * hasn't passed.
 */
export function settle_payment({
  total,
  amount_paid_input,
  has_customer,
  repayment_date_input,
  now = new Date(),
}: {
  total: number;
  amount_paid_input: string | null;
  has_customer: boolean;
  repayment_date_input: string | null;
  now?: Date;
}): Settlement {
  let amount_paid = total;

  if (amount_paid_input !== null && amount_paid_input.trim() !== "") {
    const parsed = Number(amount_paid_input);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new RuleError("Amount paid must be 0 or more.");
    }
    amount_paid = round_money(parsed);
  }

  if (amount_paid > total) {
    throw new RuleError(
      `Amount paid can't be more than the sale total ($${total.toFixed(2)}).`,
    );
  }

  const remaining = round_money(total - amount_paid);

  if (remaining === 0) {
    return { amount_paid, remaining: 0, status: "paid", repayment_date: now };
  }

  if (!has_customer) {
    throw new RuleError(
      "Walk-in sales must be paid in full. Select a customer to sell on credit.",
    );
  }

  if (!repayment_date_input) {
    throw new RuleError("Repayment date is required for a sale on credit.");
  }

  const repayment_date = new Date(repayment_date_input);
  if (Number.isNaN(repayment_date.getTime())) {
    throw new RuleError("Repayment date is not a valid date.");
  }
  if (shop_day_key(repayment_date) < shop_day_key(now)) {
    throw new RuleError("Repayment date can't be in the past.");
  }

  return {
    amount_paid,
    remaining,
    status: amount_paid === 0 ? "unpaid" : "partial",
    repayment_date,
  };
}

/** Status of a sale after a repayment brings its balance to `remaining`. */
export function status_after_repayment(remaining: number) {
  return remaining === 0 ? "paid" : "partial";
}

export type ProductInput = {
  price: number;
  cost_price: number;
  stock_qty: number;
};

/** Reads and checks the price, cost and stock fields of the product form. */
export function parse_product_numbers(
  price_input: FormDataEntryValue | null,
  cost_input: FormDataEntryValue | null,
  stock_input: FormDataEntryValue | null,
): ProductInput {
  const price = to_number(price_input);
  const cost_price = to_number(cost_input);
  const stock_qty = to_number(stock_input);

  if (price === null || cost_price === null || stock_qty === null) {
    throw new RuleError("Please fill in all required fields.");
  }
  if (price < 0 || cost_price < 0) {
    throw new RuleError("Prices can't be negative.");
  }
  if (!Number.isInteger(stock_qty) || stock_qty < 0) {
    throw new RuleError("Stock must be a whole number, 0 or more.");
  }
  if (round_money(price) < round_money(cost_price)) {
    throw new RuleError("Selling price can't be below the cost price.");
  }

  return {
    price: round_money(price),
    cost_price: round_money(cost_price),
    stock_qty,
  };
}

function to_number(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
