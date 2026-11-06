# Reference data used by the cleaning pipeline

`natural_earth_india_region.geojson`: land (including minor islands) and India's neighbouring
countries, clipped to the region around India and simplified to about 300 m. It comes from
Natural Earth 1:10m v5.1.2 (`ne_10m_land`, `ne_10m_minor_islands`, and `ne_10m_admin_0_countries_ind`,
which shows borders from India's point of view). Natural Earth is public domain.

`scripts/build_data.py` uses it only to catch gross location errors. It drops a washroom if it is more
than 2 km inside a neighbouring country or more than 10 km from any land. Those margins are wider
than the map's own accuracy, so real beach, island and border-town washrooms are never dropped.
