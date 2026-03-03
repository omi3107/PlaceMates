import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
    await prisma.oAuthAccount.deleteMany();
    await prisma.linkedInData.deleteMany();
    await prisma.userProfile.deleteMany();
    await prisma.userAuth.deleteMany();
    console.log("Wiped all data!");
}
main().finally(() => prisma.$disconnect());
