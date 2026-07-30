ALTER TABLE "town"."actors" ADD COLUMN "community_commitment_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "town"."actors" ADD COLUMN "community_commitment_version" text;--> statement-breakpoint
ALTER TABLE "town"."actors" ADD CONSTRAINT "actors_community_commitment_pair" CHECK ((
        ("town"."actors"."community_commitment_accepted_at" is null
          and "town"."actors"."community_commitment_version" is null)
        or ("town"."actors"."community_commitment_accepted_at" is not null
          and "town"."actors"."community_commitment_version" is not null
          and "town"."actors"."community_id" is not null)
      ));
