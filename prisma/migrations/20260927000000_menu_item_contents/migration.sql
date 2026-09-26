-- MenuItem: what is actually in the plate per head, shown to customers on tap
-- (e.g. {"1 plate of jollof rice","2 pieces of chicken","Moi-moi","Drink: Chapman"}).
ALTER TABLE "MenuItem" ADD COLUMN "contents" TEXT[] DEFAULT ARRAY[]::TEXT[];
