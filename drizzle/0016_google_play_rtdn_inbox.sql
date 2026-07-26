CREATE TABLE "town"."google_play_rtdn_inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pubsub_subscription" text NOT NULL,
	"message_id" text NOT NULL,
	"notification_kind" text NOT NULL,
	"notification_type" integer,
	"purchase_token" text NOT NULL,
	"event_time_millis" bigint NOT NULL,
	"subscription_id" text,
	"raw_payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "google_play_rtdn_inbox_subscription_message_unique" UNIQUE("pubsub_subscription","message_id"),
	CONSTRAINT "google_play_rtdn_inbox_pubsub_subscription_nonempty" CHECK (char_length("town"."google_play_rtdn_inbox"."pubsub_subscription") > 0),
	CONSTRAINT "google_play_rtdn_inbox_message_id_nonempty" CHECK (char_length("town"."google_play_rtdn_inbox"."message_id") > 0),
	CONSTRAINT "google_play_rtdn_inbox_purchase_token_nonempty" CHECK (char_length("town"."google_play_rtdn_inbox"."purchase_token") > 0),
	CONSTRAINT "google_play_rtdn_inbox_notification_kind_valid" CHECK ("town"."google_play_rtdn_inbox"."notification_kind" in ('subscription', 'one_time', 'voided')),
	CONSTRAINT "google_play_rtdn_inbox_raw_payload_object" CHECK (jsonb_typeof("town"."google_play_rtdn_inbox"."raw_payload") = 'object'),
	CONSTRAINT "google_play_rtdn_inbox_payload_hash_valid" CHECK ("town"."google_play_rtdn_inbox"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "google_play_rtdn_inbox_unprocessed_received_at_idx" ON "town"."google_play_rtdn_inbox" USING btree ("received_at") WHERE "town"."google_play_rtdn_inbox"."processed_at" is null;
