import { getDb } from './database.js';

export async function ensureSchema(db = getDb()) {
  if (!(await db.schema.hasTable('users'))) {
    await db.schema.createTable('users', (t) => {
      t.increments('id').primary();
      t.string('username', 64).notNullable().unique();
      t.string('password', 255).notNullable();
      t.string('role', 32).notNullable().defaultTo('user');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('settings'))) {
    await db.schema.createTable('settings', (t) => {
      t.string('key', 128).primary();
      t.text('value');
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('vendors'))) {
    await db.schema.createTable('vendors', (t) => {
      t.increments('id').primary();
      t.string('name', 128).notNullable();
      t.text('manufacturer_patterns');
      t.text('product_patterns');
      t.string('parameter_prefix', 255);
      t.string('service_list_path', 255);
      t.string('lan_binding_path', 255);
      t.string('vlan_id_path', 255);
      t.string('wifi_password_path', 255);
      t.string('http_wan_enable_path', 255);
      t.string('firewall_level_path', 255);
      t.integer('priority').notNullable().defaultTo(10);
      t.boolean('enabled').notNullable().defaultTo(true);
      t.text('description');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('wifi_security_mappings'))) {
    await db.schema.createTable('wifi_security_mappings', (t) => {
      t.increments('id').primary();
      t.integer('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.string('raw_security_value', 128).notNullable();
      t.string('normalized_security', 128).notNullable();
      t.text('description');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('wifi_security_config'))) {
    await db.schema.createTable('wifi_security_config', (t) => {
      t.increments('id').primary();
      t.string('product_class', 128).notNullable();
      t.string('security_types', 255);
      t.string('password_param_path', 255);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('mapping_nodes'))) {
    await db.schema.createTable('mapping_nodes', (t) => {
      t.increments('id').primary();
      t.string('node_id', 128).notNullable().unique();
      t.string('type', 32).notNullable();
      t.string('name', 255).notNullable();
      t.decimal('latitude', 10, 7).notNullable();
      t.decimal('longitude', 10, 7).notNullable();
      t.integer('capacity');
      t.string('splitter', 64);
      t.string('pppoe', 255);
      t.text('notes');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('mapping_edges'))) {
    await db.schema.createTable('mapping_edges', (t) => {
      t.increments('id').primary();
      t.string('edge_id', 128).notNullable().unique();
      t.string('source', 128).notNullable().references('node_id').inTable('mapping_nodes').onDelete('CASCADE');
      t.string('target', 128).notNullable().references('node_id').inTable('mapping_nodes').onDelete('CASCADE');
      t.string('fiber_type', 32);
      t.decimal('distance', 10, 2);
      t.text('waypoints');
      t.text('notes');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('map_settings'))) {
    await db.schema.createTable('map_settings', (t) => {
      t.integer('id').primary();
      t.string('center_lat', 32).notNullable();
      t.string('center_lng', 32).notNullable();
      t.string('max_zoom_in', 8).notNullable();
      t.string('max_zoom_out', 8).notNullable();
      t.string('default_zoom', 8).notNullable();
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }
}
