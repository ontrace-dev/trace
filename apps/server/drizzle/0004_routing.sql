CREATE TABLE "agent_status" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_status_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "routing_group_members" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	CONSTRAINT "routing_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "routing_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match" text DEFAULT 'any' NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "routing" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "routing" jsonb;--> statement-breakpoint
ALTER TABLE "agent_status" ADD CONSTRAINT "agent_status_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_status" ADD CONSTRAINT "agent_status_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_group_members" ADD CONSTRAINT "routing_group_members_group_id_routing_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."routing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_group_members" ADD CONSTRAINT "routing_group_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_group_members" ADD CONSTRAINT "routing_group_members_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_groups" ADD CONSTRAINT "routing_groups_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_group_id_routing_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."routing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routing_group_members_org_idx" ON "routing_group_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "routing_groups_org_idx" ON "routing_groups" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "routing_rules_org_idx" ON "routing_rules" USING btree ("org_id","position");