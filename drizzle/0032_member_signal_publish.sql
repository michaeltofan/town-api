CREATE TABLE "town"."signal_media_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"kind" text NOT NULL,
	"byte_size" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_media_uploads_kind_valid" CHECK ("town"."signal_media_uploads"."kind" in ('image')),
	CONSTRAINT "signal_media_uploads_status_valid" CHECK ("town"."signal_media_uploads"."status" in ('pending', 'attached', 'abandoned')),
	CONSTRAINT "signal_media_uploads_content_type_valid" CHECK ("town"."signal_media_uploads"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "signal_media_uploads_byte_size_positive" CHECK ("town"."signal_media_uploads"."byte_size" > 0),
	CONSTRAINT "signal_media_uploads_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "town"."signal_media_uploads" ADD CONSTRAINT "signal_media_uploads_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "town"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_media_uploads" ADD CONSTRAINT "signal_media_uploads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signal_media_uploads" ADD CONSTRAINT "signal_media_uploads_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "town"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_media_uploads_account_created_at_idx" ON "town"."signal_media_uploads" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "town"."signals" ADD COLUMN "author_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD COLUMN "author_account_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD COLUMN "media_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_author_actor_id_fkey" FOREIGN KEY ("author_actor_id") REFERENCES "town"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "town"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_media_upload_id_fkey" FOREIGN KEY ("media_upload_id") REFERENCES "town"."signal_media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_media_upload_id_unique" UNIQUE("media_upload_id");--> statement-breakpoint
ALTER TABLE "town"."signals" ADD CONSTRAINT "signals_member_author_pair" CHECK ((
  ("author_actor_id" is null and "author_account_id" is null)
  or ("author_actor_id" is not null and "author_account_id" is not null)
));
